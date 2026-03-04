import ffmpeg
import torch
import numpy as np
import os
import asyncio
import asyncio.subprocess
import subprocess
import logging
import time
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple
import colorlog
import cv2
from collections import Counter
from scipy.io import wavfile
import gc
from memory_profiler import profile_memory_usage
from logger import crash_logger
import traceback

try:
    from faster_whisper import WhisperModel
    import spacy
except ImportError:
    pass

@profile_memory_usage
def get_face_crop(video_path: str, start_time: float, duration: float) -> str:
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_MSEC, (start_time + duration / 2) * 1000)
    ret, frame = cap.read()
    if not ret:
        cap.release()
        return ""
    
    h, w, _ = frame.shape
    if w / h < 0.6: # Already vertical
        cap.release()
        return ""
        
    target_w = int(h * (9/16))
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)
    
    try:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        center_x = w // 2
        if len(faces) > 0:
            faces = sorted(faces, key=lambda x: x[2]*x[3], reverse=True)
            fx, fy, fw, fh = faces[0]
            center_x = fx + fw // 2
            
        crop_x = max(0, min(center_x - target_w // 2, w - target_w))
        cap.release()
        
        crop_x = crop_x - (crop_x % 2)
        target_w = target_w - (target_w % 2)
        h = h - (h % 2)
        
        # Cleanup memory immediately for large images
        del frame
        del gray
        del faces
        gc.collect()
        
        return f"crop={target_w}:{h}:{crop_x}:0"
    except Exception as e:
        cap.release()
        return ""

# Removed global logging.basicConfig as logging is now handled per instance

def format_eta(seconds: float) -> str:
    """Format seconds into a human-readable ETA string."""
    if seconds < 0 or seconds > 86400:
        return "calculating..."
    secs = int(seconds)
    if secs < 60:
        return f"{secs}s"
    elif secs < 3600:
        m, s = divmod(secs, 60)
        return f"{m}m {s}s"
    else:
        h, remainder = divmod(secs, 3600)
        m, s = divmod(remainder, 60)
        return f"{h}h {m}m {s}s"


def parse_ffmpeg_time(time_str: str) -> float:
    """Parse FFmpeg time string (HH:MM:SS.ms) to seconds."""
    parts = time_str.split(':')
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp a value between lo and hi."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def seconds_to_smpte(seconds: float, fps: float = 30.0) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    f = int(round((seconds - int(seconds)) * fps))
    if f >= fps:
        f = int(fps) - 1
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"

class VideoProcessor:
    def __init__(self, file_paths: List[Path], output_dir: Path, file_id: str = "temp", audio_stream_index: int = -1):
        self.file_paths = file_paths
        # Handle single file for backward compatibility
        self.file_path = file_paths[0] if isinstance(file_paths, list) and file_paths else file_paths
        if not isinstance(self.file_paths, list):
            self.file_paths = [self.file_paths]
            
        self.output_dir = output_dir
        self.output_dir.mkdir(exist_ok=True, parents=True) # Kept parents=True for safety
        self.file_id = file_id
        self.audio_stream_index = audio_stream_index
        self.settings: Dict[str, Any] = {}
        
        # Setup logging
        self.logger = logging.getLogger(f"processor_{file_id}")
        self.source_map: List[Dict[str, Any]] = [] # metadata for merged files
        if not self.logger.handlers:
            handler = logging.StreamHandler()
            formatter = colorlog.ColoredFormatter(
                "%(log_color)s%(levelname)-8s%(reset)s %(blue)s%(message)s"
            )
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
            self.logger.setLevel(logging.INFO)

        self.status_callback: Any = None
        self.current_proc: asyncio.subprocess.Process | None = None
        self.current_procs: set[asyncio.subprocess.Process] = set()
        self.cancelled = False
        self.segments: List[Dict[str, float]] = [] # Store analysis results
        self.completion_event = asyncio.Event()
        self.final_output: Path | None = None

    @classmethod
    async def concat_videos(cls, file_paths: List[Path], output_path: Path) -> Path:
        """Concatenate multiple videos into a single file using FFmpeg concat demuxer."""
        if not file_paths:
            raise ValueError("No input files provided")

        if len(file_paths) == 1:
            import shutil
            shutil.copy(file_paths[0], output_path)
            return output_path
        
        # Create concat list file
        concat_list_path = output_path.parent / f"{output_path.stem}_concat_list.txt"
        with open(concat_list_path, 'w') as f:
            for path in file_paths:
                # Escape single quotes for ffmpeg concat list: ' -> '\''
                escaped_path = str(path.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped_path}'\n")
        # FFmpeg command for stream copy (fastest)
        # Note: Input files must have same codecs/params for this to work perfectly.
        # If not, we might need re-encoding, but let's try copy first for speed.
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_path),
            "-c", "copy",
            "-loglevel", "error",
            str(output_path)
        ]

        # Run ffmpeg
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            error_msg = stderr.decode() if stderr else "Unknown ffmpeg error"
            raise RuntimeError(f"Concatenation failed: {error_msg}")

        return output_path

    def cancel(self):
        """Cancel the current operation."""
        self.cancelled = True
        self.log("Cancellation wrapper requested...")
        if self.current_proc is not None:
            try:
                self.current_proc.kill()
                self.log("Killed current active process")
            except Exception as e:
                self.log(f"Failed to kill process: {e}")
                
        for proc in list(self.current_procs):
            try:
                proc.kill()
            except Exception as e:
                pass
        self.current_procs.clear()
        gc.collect()

    def log(self, msg: str) -> None:
        logging.debug(msg)
        crash_logger.debug(msg)

    def set_callback(self, callback: Any) -> None:
        self.status_callback = callback

    async def _emit_status(self, step: str, progress: float, details: str = "", eta_seconds: float = -1) -> None:
        # Store state directly on the processor for API polling
        self.current_step = step
        self.progress = progress
        
        if eta_seconds >= 0:
            self.eta_display = format_eta(eta_seconds)
        else:
            self.eta_display = "calculating..."
            
        if self.status_callback:
            # Use int() for clean progress values, avoiding round() Pyright overload issues
            progress_val = int(progress * 10) / 10.0  # manual round to 1 decimal
            eta_val = int(eta_seconds * 10) / 10.0 if eta_seconds >= 0 else -1

            msg: Dict[str, Any] = {
                "step": step,
                "progress": progress_val,
                "details": details
            }
            if eta_seconds >= 0:
                msg["eta_seconds"] = eta_val
                msg["eta_display"] = self.eta_display
            await self.status_callback(msg)

    @profile_memory_usage
    async def process_async(self, auto_render: bool = False) -> str | None:
        """Main processing pipeline — runs heavy work in a thread pool to avoid blocking."""
        try:
            self.cancelled = False
            self.log("Starting analysis...")
            await self._emit_status("initializing", 0, "Starting analysis...")

            if self.cancelled: raise RuntimeError("Cancelled")

            # Get total video duration for progress calculations
            total_duration = 0.0
            for p in self.file_paths:
                probe = ffmpeg.probe(str(p))
                total_duration += float(probe['format']['duration'])
            self.log(f"Total video duration: {total_duration:.1f}s across {len(self.file_paths)} files")

            if self.settings.get('merge_only'):
                self.log("Merge Only mode active. Skipping AI analysis, but extracting audio for Waveform generation.")
                
                loop = asyncio.get_running_loop()
                audio_path = await self._extract_audio_with_progress(loop, total_duration)
                self.log(f"Audio extracted to {audio_path}")
                
                speech_timestamps = [{'start': 0.0, 'end': total_duration, 'type': 'keep'}]
                self.segments = speech_timestamps
                total_speech = total_duration
                
                # Write dummy VAD out for frontend polling success
                import json
                try:
                    with open(self.output_dir / f"{self.file_id}_vad.json", "w") as f:
                        json.dump({
                            "segments": speech_timestamps,
                            "total_speech": total_speech,
                            "original_duration": total_duration,
                            "waveform": self.get_waveform_data()
                        }, f)
                except Exception as e:
                    self.log(f"Failed to write dummy VAD file: {e}")
                    
                await self._emit_status("vad_analysis", 50, "Merge Only mode enabled. Bypassing AI analysis.")
            else:
                # 1. Extract Audio with progress (0% - 20%)
                self.log(f"Extracting audio from {self.file_path}")
                loop = asyncio.get_running_loop()
                audio_path = await self._extract_audio_with_progress(loop, total_duration)
                self.log(f"Audio extracted to {audio_path}")
                await self._emit_status("audio_extraction", 20, "Audio extracted")
    
                # 2. VAD Analysis with progress (20% - 50%)
                self.log("Starting VAD analysis")
                speech_timestamps = await self._detect_voice_with_progress(loop, audio_path, total_duration)
                
                # STORE SEGMENTS FOR API ACCESS
                self.segments = speech_timestamps
    
                # Log useful debug info
                total_speech = sum(t['end'] - t['start'] for t in speech_timestamps)
                self.log(f"Found {len(speech_timestamps)} speech segments, total speech: {total_speech:.1f}s / {total_duration:.1f}s")
                for i, ts in enumerate(speech_timestamps):
                    self.log(f"  Segment {i}: {ts['start']:.2f}s - {ts['end']:.2f}s (duration: {ts['end']-ts['start']:.2f}s)")
    
                await self._emit_status("vad_analysis", 50, f"Found {len(speech_timestamps)} speech segments ({total_speech:.1f}s of speech)")

            if not auto_render:
                self.log("Analysis complete. Waiting for supervisor review.")
                await self._emit_status("analysis_complete", 50, "Ready for Review")
                return None

            # 3. Render with progress (50% - 100%)
            self.log("Rendering video")
            output_file = await self._render_video_with_progress(loop, speech_timestamps, total_speech)
            self.log("Video processing complete")
            await self._emit_status("rendering", 100, "Video processing complete")

            self.final_output = output_file
            self.completion_event.set()
            return str(output_file)

        except Exception as e:
            self.log(f"Process Error: {e}")
            self.log(traceback.format_exc())
            crash_logger.error(f"Processor fatal exception: {e}\n{traceback.format_exc()}")
            await self._emit_status("error", 0, str(e))
            raise e

    async def _extract_audio_with_progress(self, loop: asyncio.AbstractEventLoop, total_duration: float) -> Path:
        """Extract audio with real-time progress tracking using async subprocess."""
        audio_path = self.output_dir / f"{self.file_id}_{self.file_path.stem}_merged.wav"
        
        # Virtual concat of audio for VAD analysis
        concat_list_path = self.output_dir / f"{self.file_id}_audio_concat.txt"
        with open(concat_list_path, 'w') as f:
            for p in self.file_paths:
                escaped = str(p.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        map_args = []
        if getattr(self, "audio_stream_index", -1) >= 0:
            map_args = ["-map", f"0:{self.audio_stream_index}"]

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list_path),
            *map_args,
            "-ac", "1", "-ar", "16000",
            "-af", "pan=mono|c0=c0",
            "-progress", "pipe:1",
            "-loglevel", "error",
            str(audio_path)
        ]

        with open(self.output_dir / "ffmpeg_audio_stderr.log", "w") as stderr_log:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr_log
            )
            self.current_proc = proc
            start_time = time.time()

            if proc.stdout is None:
                 raise RuntimeError("Failed to open ffmpeg stdout")
                 
            try:
                while True:
                    if self.cancelled:
                        if self.current_proc is not None:
                            self.current_proc.terminate()
                        raise RuntimeError("Cancelled by user")
                    line_bytes = await proc.stdout.readline()
                    if not line_bytes:
                        break
                    line = line_bytes.decode('utf-8', errors='replace')
                    if line.startswith("out_time="):
                        time_str = line.split("=")[1].strip()
                        if time_str and time_str != "N/A":
                            current_time = parse_ffmpeg_time(time_str)
                            if total_duration > 0:
                                fraction = _clamp(current_time / total_duration, 0.0, 1.0)
                                progress = fraction * 20  # 0-20% range
                                elapsed = time.time() - start_time
                                eta = (elapsed / fraction) * (1.0 - fraction) if fraction > 0.0 else -1
                                await self._emit_status(
                                    "audio_extraction", progress,
                                    f"Extracting audio... {int(fraction * 100)}%",
                                    eta
                                )

                if self.current_proc is not None:
                    await self.current_proc.wait()
            finally:
                self.current_proc = None
        
        if proc.returncode != 0 and not self.cancelled:
            try:
                with open(self.output_dir / "ffmpeg_audio_stderr.log", "r") as f:
                    stderr = f.read()
            except Exception:
                stderr = "unknown error (check log file)"
            raise RuntimeError(f"Audio extraction failed: {stderr}")

        try:
            if concat_list_path.exists():
                concat_list_path.unlink()
        except Exception:
            pass

        return audio_path

    async def _detect_voice_with_progress(self, loop: asyncio.AbstractEventLoop, audio_path: Path, total_duration: float) -> List[Dict[str, float]]:
        """Run VAD with progress updates."""
        if self.cancelled: raise RuntimeError("Cancelled")
        await self._emit_status("vad_analysis", 22, "Loading VAD model...", -1)

        def _load_model() -> Any:
            try:
                model, utils = torch.hub.load(
                    repo_or_dir='snakers4/silero-vad',
                    model='silero_vad',
                    force_reload=False,
                    trust_repo=True
                )
                
                device = torch.device('cpu')
                if torch.cuda.is_available():
                    device = torch.device('cuda')
                elif getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
                    device = torch.device('mps')
                    
                self.log(f"Hardware Acceleration for VAD: {device}")
                model = model.to(device)
                
                return model, utils, device
            except Exception as e:
                self.log(f"Error loading VAD model: {e}")
                raise RuntimeError(f"Failed to load VAD model: {e}")

        result = await loop.run_in_executor(None, _load_model)  # type: ignore[arg-type]
        model, utils, device = result
        await self._emit_status("vad_analysis", 30, "Model loaded, analyzing speech...", -1)

        (get_speech_timestamps, _, read_audio, _, _) = utils

        def _run_vad() -> Tuple[List[Dict[str, float]], float]:
            start = time.time()
            try:
                wav = read_audio(str(audio_path))
                wav = wav.to(device)
                
                # Apply Dynamic Settings
                LEADING_PAD = self.settings.get('pad_start', 0.08)
                TRAILING_PAD = self.settings.get('pad_end', 0.08)
                VAD_THRESHOLD = self.settings.get('vad_threshold', 0.35)
                MIN_SILENCE = self.settings.get('min_silence_duration_ms', 200)
                MIN_SPEECH = self.settings.get('min_speech_duration_ms', 100)
                MAX_SILENCE = self.settings.get('max_silence_duration_ms', 5000) / 1000.0
                MAX_SPEECH = self.settings.get('max_speech_duration_ms', 10000) / 1000.0
                
                raw_stamps = get_speech_timestamps(
                    wav, model,
                    return_seconds=True,
                    threshold=VAD_THRESHOLD,
                    min_speech_duration_ms=MIN_SPEECH,
                    min_silence_duration_ms=MIN_SILENCE,
                    speech_pad_ms=80
                )
                
                # Apply Max Limits
                processed_stamps = []
                last_end = 0.0
                import math
                for ts in raw_stamps:
                    # 1. Enforce Max Silence (Keep up to MAX_SILENCE of a long gap)
                    gap = ts['start'] - last_end
                    if last_end > 0 and gap > MAX_SILENCE:
                        # Append the max allowed silence as a kept segment attached to the previous speech
                        processed_stamps.append({
                            "start": last_end,
                            "end": last_end + MAX_SILENCE
                        })
                        
                    # 2. Enforce Max Speech (Split long continuous speeches)
                    speech_len = ts['end'] - ts['start']
                    if speech_len > MAX_SPEECH:
                        chunks = int(math.ceil(speech_len / MAX_SPEECH))
                        chunk_dur = speech_len / chunks
                        for i in range(chunks):
                            processed_stamps.append({
                                "start": ts['start'] + i * chunk_dur,
                                "end": ts['start'] + (i + 1) * chunk_dur
                            })
                    else:
                        processed_stamps.append(ts)
                        
                    last_end = ts['end']
                
                # Apply Dynamic Audio Padding
                stamps = []
                for ts in processed_stamps:
                     padded_start = max(0.0, ts['start'] - LEADING_PAD)
                     padded_end = min(total_duration, ts['end'] + TRAILING_PAD)
                     stamps.append({"start": padded_start, "end": padded_end})
                
            except Exception as e:
                self.log(f"Error executing VAD: {e}")
                raise RuntimeError(f"VAD execution failed: {e}")
            elapsed = time.time() - start
            return stamps, elapsed

        # Run VAD in a thread via run_in_executor (avoids Pyright executor.submit type issue)
        start_time = time.time()
        vad_future = loop.run_in_executor(None, _run_vad)  # type: ignore[arg-type]

        # Poll for completion and update progress
        while not vad_future.done():
            if self.cancelled:
                # We can't easily kill the thread running VAD, but we can abandon it
                raise RuntimeError("Cancelled by user")
            
            elapsed = time.time() - start_time
            # Estimate: VAD typically processes at ~50x real-time on CPU
            estimated_vad_time = max(total_duration / 50.0, 5.0)
            fraction = _clamp(elapsed / estimated_vad_time, 0.0, 0.95)
            progress = 30 + fraction * 18  # 30-48% range
            eta = max(estimated_vad_time - elapsed, 0.0)
            await self._emit_status(
                "vad_analysis", progress,
                f"Analyzing speech patterns... {int(fraction * 100)}%",
                eta
            )
            await asyncio.sleep(0.5)

        # Get result after loop finishes
        try:
            speech_timestamps, _vad_elapsed = await vad_future
        except Exception as e:
            self.log(f"VAD Future failed (check installed libraries like soundfile): {e}")
            raise RuntimeError(f"VAD analysis failed. Ensure 'soundfile' is installed. Error: {e}")
        finally:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                torch.mps.empty_cache()
            gc.collect()
            
        # Merge overlapping timestamps to avoid video repetition
        speech_timestamps = self._merge_timestamps(speech_timestamps)

        return speech_timestamps

    def get_waveform_data(self, points_per_second: int = 20) -> List[float]:
        """Generate waveform peaks for visualization."""
        # The extracted audio file
        wav_path = self.output_dir / f"{self.file_id}_{self.file_path.stem}_merged.wav"
        
        if not wav_path.exists():
            self.log(f"Waveform error: {wav_path} not found")
            return []
            
        try:
            # Read WAV file
            sample_rate, data = wavfile.read(str(wav_path))
            
            # Convert to mono if stereo
            if len(data.shape) > 1:
                data = np.mean(data, axis=1)
                
            # Handle empty data
            if len(data) == 0:
                return []

            # Normalize to 0-1 range based on absolute max
            max_val = np.max(np.abs(data))
            if max_val > 0:
                data = data / max_val
            
            # Calculate step size for downsampling
            step = int(sample_rate / points_per_second)
            if step < 1: step = 1
            
            # Pad to make length divisible by step
            pad_len = (step - len(data) % step) % step
            if pad_len > 0:
                data = np.pad(data, (0, pad_len))
                
            # Resample by taking max amplitude in each window (peak detection)
            # Reshape to (num_windows, step) and take max of absolute values along axis 1
            peaks = np.max(np.abs(data.reshape(-1, step)), axis=1)
            
            # Return rounded floats for compact JSON
            return [round(float(x), 3) for x in peaks]
            
        except Exception as e:
            self.log(f"Error generating waveform: {e}")
            return []

    def _merge_timestamps(self, timestamps: List[Dict[str, float]], min_gap: float = 0.2) -> List[Dict[str, float]]:
        """Merge overlapping or adjacent timestamps to prevent video repetition."""
        if not timestamps:
            return []
        
        # Sort by start time
        timestamps.sort(key=lambda x: x['start'])
        
        merged = []
        current = timestamps[0].copy()
        
        for next_ts in timestamps[1:]:
            # Check overlap OR close proximity (gap < min_gap)
            # If the next segment starts before the current one ends + min_gap, merge them.
            if next_ts['start'] < current['end'] + min_gap:
                # Merge
                current['end'] = max(current['end'], next_ts['end'])
            else:
                merged.append(current)
                current = next_ts.copy()
        merged.append(current)
        return merged

    @profile_memory_usage
    async def _render_video_with_progress(self, loop: asyncio.AbstractEventLoop, timestamps: List[Dict[str, float]], total_duration: float, settings: Dict[str, Any] = None) -> Path:
        """Render video by extracting each segment individually for frame-accurate cuts,
        then concatenating with stream copy. This avoids the concat demuxer's keyframe-seeking
        bug that causes repeated words at segment boundaries."""
        if self.cancelled: raise RuntimeError("Cancelled")
        
        settings = settings or {}
        silence_action = settings.get("silence_action", "delete")
        auto_frame = settings.get("auto_frame", False)
        
        # Feature 'speed_up' removed. silence_action = 'delete' is the only supported operation.
        
        if not timestamps:
            self.log("No speech detected. Returning original video.")
            output_path = self.output_dir / f"{self.file_path.name}"
            import shutil
            shutil.copy(self.file_path, output_path)
            return output_path

        output_path = self.output_dir / f"{self.file_paths[0].stem}_processed.mp4"

        # Calculate file intervals for virtual concatenation
        file_intervals = []
        cumulative = 0.0
        for p in self.file_paths:
            probe = ffmpeg.probe(str(p))
            dur = float(probe['format']['duration'])
            file_intervals.append({
                "path": p,
                "start": cumulative,
                "end": cumulative + dur
            })
            cumulative += dur

        # FAILSAFE: Ensure no segment overlap
        safe_timestamps = []
        last_end = 0.0
        for ts in timestamps:
            start = ts['start']
            end = ts['end']
            if start < last_end:
                start = last_end
            if end <= start:
                continue
            safe_timestamps.append({"start": start, "end": end})
            last_end = end

        # If timestamps already contain 'type' from ManualEditor
        has_types = any('type' in ts for ts in timestamps)
        
        full_segments = []
        if has_types:
            full_segments = timestamps
        else:
            last_end = 0.0
            for ts in safe_timestamps:
                if ts['start'] > last_end + 0.1:
                    full_segments.append({"start": last_end, "end": ts['start'], "type": "cut"})
                full_segments.append({"start": ts['start'], "end": ts['end'], "type": "keep"})
                last_end = ts['end']
            if last_end < total_duration - 0.1:
                full_segments.append({"start": last_end, "end": total_duration, "type": "cut"})

        # CRITICAL BUG FIX: If a segment spans across multiple source files (e.g. Merge Only),
        # we must split it into multiple sub-segments exactly at the file boundaries.
        # Otherwise, FFmpeg will only extract up to the end of the first file it touches.
        
        self.log(f"DEBUG file_intervals: {file_intervals}")
        self.log(f"DEBUG full_segments BEFORE split: {full_segments}")
        
        split_segments = []
        for seg in full_segments:
            seg_start = seg['start']
            seg_end = seg['end']
            seg_type = seg.get('type', 'keep')
            
            # Intersect this segment with all source file intervals
            for f_int in file_intervals:
                overlap_start = max(seg_start, f_int['start'])
                # Avoid floating point edge cases by rounding
                overlap_start = round(overlap_start, 4)
                overlap_end = min(seg_end, f_int['end'])
                overlap_end = round(overlap_end, 4)
                
                if overlap_start < overlap_end - 0.01:
                    split_segments.append({
                        "start": overlap_start,
                        "end": overlap_end,
                        "type": seg_type
                    })
        
        full_segments = split_segments
        
        self.log(f"DEBUG full_segments AFTER split: {full_segments}")

        n = len([s for s in full_segments if s.get('type') != 'cut' or silence_action != 'delete'])
        self.log(f"Rendering {n} segments with per-segment extraction...")
        await self._emit_status("rendering", 52, f"Rendering {n} segments...", -1)

        # Create temp directory for segment files
        temp_dir = self.output_dir / f"{self.file_id}_segments"
        temp_dir.mkdir(exist_ok=True)

        stderr_log_path = self.output_dir / "ffmpeg_render_stderr.log"
        segment_files = []
        start_time = time.time()
        
        extracted_count = 0
        use_gpu = settings.get("use_gpu", False)
        use_turbo = settings.get("use_turbo", False)
        
        # Parallel extraction config
        concurrency = 4 if use_turbo else 1
        sem = asyncio.Semaphore(concurrency)
        tasks = []
        
        async def process_segment(idx, ts):
            nonlocal extracted_count
            if self.cancelled: return None
            
            seg_type = ts.get('type', 'keep')
            if seg_type == 'cut' and silence_action == 'delete':
                return None
                
            seg_start = ts['start']
            seg_duration = ts['end'] - ts['start']
            
            source_file = self.file_path
            local_start = seg_start
            
            best_f_int = file_intervals[0]
            max_overlap = -1.0
            for f_int in file_intervals:
                overlap = min(ts['end'], f_int['end']) - max(seg_start, f_int['start'])
                if overlap > max_overlap:
                    max_overlap = overlap
                    best_f_int = f_int
            
            source_file = best_f_int['path']
            local_start = max(0.0, seg_start - best_f_int['start'])
            # We don't need to clamp seg_duration down, because the segment is already safely split upstream.

            seg_file = temp_dir / f"seg_{idx:04d}.mp4"
            
            fade_dur = min(0.03, seg_duration / 2)
            a_filter = f"afade=t=in:ss=0:d={fade_dur:.3f},afade=t=out:st={seg_duration-fade_dur:.3f}:d={fade_dur:.3f},loudnorm=I=-14:LRA=11:TP=-1.5"

            v_filters = []

            if auto_frame:
                crop_filter = get_face_crop(str(source_file), local_start, seg_duration)
                if crop_filter: v_filters.append(crop_filter)

            aspect_ratio = settings.get("aspect_ratio", "original")
            if aspect_ratio != "original":
                target_w, target_h = {
                    "16:9": (1920, 1080),
                    "9:16": (1080, 1920),
                    "1:1": (1080, 1080),
                    "4:5": (1080, 1350)
                }.get(aspect_ratio, (1920, 1080))
                
                v_filters.append(f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease")
                # Fix "Broken Up" videos: NV12/YUV420P demands strictly even dimensions and even padding offsets
                v_filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
                v_filters.append(f"pad={target_w}:{target_h}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2")

            v_filter_str = ",".join(v_filters)
            
            hw_args = []
            if use_gpu == "nvidia":
                if torch.cuda.is_available():
                    v_codec = "h264_nvenc"
                    v_args = ["-c:v", v_codec, "-preset", "p1", "-crf", "23"] # NVENC uses p1..p7 presets
                else:
                    self.log("NVIDIA GPU requested but not available. Falling back to libx264.")
                    v_codec = "libx264"
                    v_args = ["-c:v", v_codec, "-preset", "ultrafast", "-crf", "23"]
            elif use_gpu == "amd":
                import platform
                if platform.system() == "Linux":
                    v_codec = "h264_vaapi"
                    v_args = ["-c:v", v_codec, "-qp", "23"] # VAAPI uses qp instead of crf
                    # Use -init_hw_device and -filter_hw_device to properly attach the context
                    hw_args = ["-init_hw_device", "vaapi=foo:/dev/dri/renderD128", "-filter_hw_device", "foo"]
                    
                    # VAAPI requires uploading frames to hardware surface. ALWAYS DO THIS LAST.
                    if v_filter_str:
                        v_filter_str += ",format=nv12,hwupload"
                    else:
                        v_filter_str = "format=nv12,hwupload"
                else:
                    v_codec = "h264_amf"
                    v_args = ["-c:v", v_codec, "-usage", "lowlatency", "-quality", "speed"]
            else:
                v_codec = "libx264"
                v_args = ["-c:v", v_codec, "-preset", "ultrafast", "-crf", "23"]
            
            if v_filter_str: v_args = ["-vf", v_filter_str] + v_args
            
            # Normalize AV Sync for VFR inputs and concat demuxer compatibility
            if a_filter:
                a_filter += ",aresample=async=1"
            else:
                a_filter = "aresample=async=1"

            cmd = [
                "ffmpeg", "-y",
                *hw_args,
                "-ss", f"{local_start:.3f}",
                "-i", str(source_file),
                "-t", f"{seg_duration:.3f}",
                *v_args,
                "-r", "30",
                "-af", a_filter,
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
                "-avoid_negative_ts", "make_zero",
                "-loglevel", "error",
                "-progress", "pipe:1",
                str(seg_file)
            ]

            async with sem:
                if self.cancelled: return None
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                self.current_procs.add(proc)
                
                try:
                    self.log(f"Segment {idx}: Waiting for FFmpeg communicate...")
                    # communicate() safely drains both pipes directly preventing deadlocks
                    stdout_data, stderr_data = await asyncio.wait_for(
                        proc.communicate(),
                        timeout=600.0
                    )
                    self.log(f"Segment {idx}: FFmpeg returned {proc.returncode}")
                except asyncio.TimeoutError:
                    proc.kill()
                    self.log(f"Segment {idx} timed out after 600s.")
                    self.current_procs.discard(proc)
                    raise RuntimeError(f"FFmpeg render timeout on Segment {idx}.")
                except Exception as e:
                    proc.kill()
                    self.log(f"Segment {idx} failed: {e}")
                    self.current_procs.discard(proc)
                    raise RuntimeError(f"FFmpeg render failed on Segment {idx}: {e}")
                
                self.current_procs.discard(proc)

                if proc.returncode != 0 and not self.cancelled:
                    err = stderr_data.decode(errors='replace') if stderr_data else "unknown"
                    self.log(f"Segment {idx} failed: {err}")
                    if seg_file.exists(): seg_file.unlink()
                    return None
                    
                extracted_count += 1
                self.log(f"Segment {idx}: Extracted successfully.")
                fraction = extracted_count / max(1, n)
                progress = 50 + fraction * 40
                elapsed = time.time() - start_time
                eta = (elapsed / fraction) * (1.0 - fraction) if fraction > 0.0 else -1
                
                # Only emit the final block if we are rendering multiple chunks
                if not settings.get('merge_only') and n > 1:
                    await self._emit_status(
                        "rendering", progress,
                        f"Extracting segment {extracted_count}/{n}...",
                        eta
                    )
                
            return seg_file

        # STEP 1: Launch tasks
        from collections import OrderedDict
        job_tasks = [process_segment(i, ts) for i, ts in enumerate(full_segments)]
        results = await asyncio.gather(*job_tasks, return_exceptions=False)
        
        for res in results:
            if res is not None:
                segment_files.append(res)
                
        self.current_procs.clear()

        if not segment_files:
            raise RuntimeError("All segments failed to extract")

        # STEP 2: Concatenate all segment files with stream copy (fast, no re-encode)
        concat_list_path = self.output_dir / f"{self.file_path.stem}_concat.txt"
        with open(concat_list_path, 'w') as f:
            for seg_file in segment_files:
                escaped = str(seg_file.absolute()).replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        self.log(f"Concatenating {len(segment_files)} segments...")
        await self._emit_status("rendering", 92, "Joining segments...", -1)

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_path),
            "-c", "copy",
            "-loglevel", "error",
            str(output_path)
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        self.current_proc = proc
        _, stderr_data = await proc.communicate()

        if proc.returncode != 0 and not self.cancelled:
            err = stderr_data.decode() if stderr_data else "unknown"
            self.log(f"Concat failed: {err}")
            raise RuntimeError(f"FFmpeg concat failed: {err}")

        self.current_proc = None

        # STEP 3: Cleanup temp segment files
        for seg_file in segment_files:
            try:
                seg_file.unlink()
            except Exception:
                pass
        try:
            if concat_list_path.exists():
                concat_list_path.unlink()
        except Exception:
            pass
        try:
            temp_dir.rmdir()
        except Exception:
            pass

        self.log(f"Output saved to {output_path}")
        return output_path

    async def render_from_segments(self, segments: List[Dict[str, float]], settings: Dict[str, Any] = None) -> str:
        """Render video from manually confirmed segments."""
        self.segments = segments # Update with user-edited segments
        
        # IMMEDIATELY emit rendering status so frontend polling doesn't exit early
        await self._emit_status("rendering", 0, "Initializing Render", -1)
        
        # Recalculate duration
        total_duration = sum(s['end'] - s['start'] for s in segments)
        loop = asyncio.get_running_loop()
        
        try:
            output_file = await self._render_video_with_progress(loop, segments, total_duration, settings)
            await self._emit_status("complete", 100, "Video processing complete", -1)
            
            self.final_output = output_file
            self.completion_event.set()
            
            return str(output_file)
        except Exception as e:
            self.log(f"Render failed: {e}")
            await self._emit_status("error", 0, str(e), -1)
            self.completion_event.set()
            raise

    def generate_edl(self, segments: List[Dict[str, float]], fps: float = 30.0) -> str:
        """Generate an Edit Decision List (EDL) file content from the current timeline."""
        lines = ["TITLE: JUMP CUTTER PROJECT", "FCM: NON-DROP FRAME\n"]
        timeline_end = 0.0
        
        # Filter for kept segments
        kept_segments = [s for s in segments if s.get('type', 'keep') == 'keep']
        
        for i, seg in enumerate(kept_segments):
            start_tc = seconds_to_smpte(seg['start'], fps)
            end_tc = seconds_to_smpte(seg['end'], fps)
            
            dur = seg['end'] - seg['start']
            rec_start_tc = seconds_to_smpte(timeline_end, fps)
            rec_end_tc = seconds_to_smpte(timeline_end + dur, fps)
            
            lines.append(f"{i+1:03d}  AX       V     C        {start_tc} {end_tc} {rec_start_tc} {rec_end_tc}")
            lines.append(f"* FROM CLIP NAME: {self.file_path.name}\n")
            
            timeline_end += dur
            
        return "\n".join(lines)

    def generate_fcpxml(self, segments: List[Dict[str, float]], fps: float = 30.0) -> str:
        """Generate a basic FCPXML file content from the current timeline."""
        basefps = "30000/1001" if abs(fps - 29.97) < 0.1 else f"{int(fps)}/1"
        if fps == 25.0: basefps = "25/1"
        elif fps == 24.0: basefps = "24/1"
        elif fps == 50.0: basefps = "50/1"
        elif fps == 60.0: basefps = "60/1"
        
        dur_total = sum((s['end'] - s['start']) for s in segments if s.get('type', 'keep') == 'keep')
        
        lines = []
        lines.append('<?xml version="1.0" encoding="UTF-8"?>')
        lines.append('<!DOCTYPE fcpxml>')
        lines.append('<fcpxml version="1.9">')
        lines.append('  <resources>')
        lines.append(f'    <format id="r1" name="FFVideoFormat1080p{int(fps)}" frameDuration="{basefps}s" width="1920" height="1080"/>')
        lines.append(f'    <asset id="r2" name="{self.file_path.name}" src="file://{self.file_path.absolute()}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2"/>')
        lines.append('  </resources>')
        lines.append('  <library>')
        lines.append('    <event name="Jump Cutter Event">')
        lines.append(f'      <project name="Jump Cutter Sequence">')
        lines.append(f'        <sequence format="r1" duration="{dur_total}s" tcStart="0s" tcFormat="NDF">')
        lines.append('          <spine>')
        
        kept_segments = [s for s in segments if s.get('type', 'keep') == 'keep']
        for i, seg in enumerate(kept_segments):
            dur = seg['end'] - seg['start']
            start = seg['start']
            lines.append(f'            <asset-clip name="{self.file_path.name}" ref="r2" duration="{dur}s" start="{start}s" format="r1"/>')
            
        lines.append('          </spine>')
        lines.append('        </sequence>')
        lines.append('      </project>')
        lines.append('    </event>')
        lines.append('  </library>')
        lines.append('</fcpxml>')
        
        return "\n".join(lines)

    async def extract_chapters_async(self, window_size: float = 60.0) -> List[Dict[str, Any]]:
        """Extract YouTube-compatible chapters asynchronously using a background thread."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self.extract_chapters, window_size)

    def extract_chapters(self, window_size: float = 60.0) -> List[Dict[str, Any]]:
        """Extract YouTube-compatible chapters using faster-whisper and spaCy (synchronous core logic)."""
        # 1. Extract audio
        audio_path = self.output_dir / f"{self.file_id}_audio_chapters.wav"
        if not audio_path.exists():
            # Build the audio map arg cleanly — never split the '-map' flag across ternary
            map_arg = f"0:a:{self.audio_stream_index}" if self.audio_stream_index >= 0 else "0:a:0?"
            cmd = [
                "ffmpeg", "-y", "-i", str(self.file_path),
                "-map", map_arg,
                "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(audio_path)
            ]
            subprocess.run(cmd, check=True, capture_output=True)

        # 2. Run Faster Whisper
        # Use INT8 quantization for tiny.en or base.en for low memory
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "int8_float16" if device == "cuda" else "int8"
        model = WhisperModel("tiny.en", device=device, compute_type=compute_type)
        
        segments_generator, info = model.transcribe(str(audio_path), beam_size=5)
        
        # 3. Group by windows
        windows = []
        current_window = []
        current_window_start = 0.0
        
        for segment in segments_generator:
            if segment.start >= current_window_start + window_size:
                if current_window:
                    windows.append({"start": current_window_start, "text": " ".join(current_window)})
                current_window_start += window_size
                current_window = [segment.text]
            else:
                current_window.append(segment.text)
                
        if current_window:
             windows.append({"start": current_window_start, "text": " ".join(current_window)})
             
        # 4. Run spaCy NLP Pipeline
        try:
            nlp = spacy.load("en_core_web_sm")
        except OSError:
            subprocess.run(["python", "-m", "spacy", "download", "en_core_web_sm"], check=True)
            nlp = spacy.load("en_core_web_sm")
            
        chapters = []
        for i, window in enumerate(windows):
            doc = nlp(window["text"])
            
            # Filter PROPN and NOUN
            candidates = [token.text for token in doc if token.pos_ in ("PROPN", "NOUN") and not token.is_stop and len(token.text) > 2]
            
            # Extract dominant noun/entity
            title = f"Chapter {i+1}"
            if candidates:
                counts = Counter(candidates)
                top_word = counts.most_common(1)[0][0]
                title = top_word.capitalize()
                
                # Try to find a noun chunk containing the top word for a better title
                for chunk in doc.noun_chunks:
                    if top_word in chunk.text:
                        title = chunk.text.title()
                        break
            
            chapters.append({
                "time": window["start"],
                "title": title
            })
            
        return chapters
