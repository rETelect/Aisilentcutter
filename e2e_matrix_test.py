import asyncio
import os
import time
import json
import logging
import traceback
from pathlib import Path

# Setup Pathing for backend imports
import sys
sys.path.insert(0, str(Path(__file__).parent / "backend"))

print("DEBUG: Importing backend processor...", flush=True)
from backend.processor import VideoProcessor
print("DEBUG: Backend processor imported successfully.", flush=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - [%(levelname)s] - E2E_TEST - %(message)s")
logger = logging.getLogger("E2E_TEST")

TEST_MEDIA_DIR = Path("test_media")

# Settings Matrix parameters
VAD_THRESHOLDS = [0.1, 0.9] # Extreme low vs Extreme high
PADDINGS = [0.0, 1.0] # 0s vs 1s Padding
ASPECT_RATIOS = ["original", "9:16"]
AUTO_FRAMES = [False, True]
SILENCE_ACTIONS = ["delete"]
USE_GPUS = ["none", "nvidia", "amd"]
USE_TURBOS = [False, True]
MERGE_ONLYS = [False, True]

def generate_combinations():
    combos = []
    for vad in VAD_THRESHOLDS:
        for pad in PADDINGS:
            for ar in ASPECT_RATIOS:
                for auto in AUTO_FRAMES:
                    for silence in SILENCE_ACTIONS:
                        for gpu in USE_GPUS:
                            for turbo in USE_TURBOS:
                                for merge in MERGE_ONLYS:
                                    # Invalid/Clashing Combinations:
                                    if auto and ar == "original":
                                        continue # Auto-frame requires a non-original AR target to pad/scale into
                                    if merge and (silence != "delete" or turbo or gpu != "none"):
                                        continue # Merge only ignores a bunch of things
                                        
                                    combos.append({
                                        "vad_threshold": vad,
                                        "pad_start": pad,
                                        "pad_end": pad,
                                        "min_silence_duration_ms": 200,
                                        "min_speech_duration_ms": 300,
                                        "aspect_ratio": ar,
                                        "auto_frame": auto,
                                        "silence_action": silence,
                                        "use_gpu": gpu,
                                        "use_turbo": turbo,
                                        "merge_only": merge
                                    })
    return combos

async def run_single_test(file_paths, settings, combo_idx, total_combos):
    logger.info(f"=== Starting Test {combo_idx}/{total_combos} ===")
    file_id = f"e2e_test_{combo_idx}"
    processor = VideoProcessor(file_paths=[Path(f) for f in file_paths], output_dir=Path("./outputs"), file_id=file_id)
    processor.logger.setLevel(logging.DEBUG)
    
    try:
        # Step 1: Analysis
        logger.info("[1/3] Running Feature Analysis & VAD...")
        await processor.process_async()
        segments = processor.segments
        if not segments:
            raise ValueError("Processor returned empty segments array.")
            
        # Step 2: Render
        logger.info("[2/3] Rendering output...")
        await processor.render_from_segments(segments, settings)
        output_file = processor.final_output
        if not output_file or not output_file.exists():
            raise FileNotFoundError("Render output file is missing.")
            
        # Validation checks on output video
        size = output_file.stat().st_size
        if size < 1000:
            raise ValueError("Output file is suspiciously small (< 1KB).")
            
        logger.info(f"[3/3] Success! Output size: {size / (1024*1024):.2f} MB")
        
        # Cleanup
        if processor.current_proc:
            try: processor.current_proc.kill()
            except: pass
        
    except Exception as e:
        logger.error(f"Test {combo_idx} FAILED!")
        logger.error(traceback.format_exc())
        return False
        
    return True


async def main():
    media_files = sorted(list(TEST_MEDIA_DIR.glob("*.mp4")))
    if not media_files:
        logger.error("No MP4 files found in test_media/")
        return
        
    logger.info(f"Found {len(media_files)} files: {[f.name for f in media_files]}")
    
    # We will test a full multi-file merge as the vector logic bounds
    file_paths = [str(f.absolute()) for f in media_files]
    
    combos = generate_combinations()
    total = len(combos)
    logger.info(f"Generated {total} permutations for E2E testing.")
    
    failed = []
    
    for i, settings in enumerate(combos, 1):
        success = await run_single_test(file_paths, settings, i, total)
        if not success:
            failed.append({
                "index": i,
                "settings": settings
            })
            # We break early to fix the code, per strict instruction:
            # "read the exact error trace, identify the flawed logic, and autonomously self-correct"
            logger.error("E2E Pipeline halted due to failure. Awaiting autonomous fix.")
            break
            
    if not failed:
        logger.info("🎉 100% STABILITY ACHIEVED! ALL TEST PERMUTATIONS PASSED. 🎉")

if __name__ == "__main__":
    asyncio.run(main())
