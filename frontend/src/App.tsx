import { useState, useRef, useEffect } from 'react';
import { Scissors, Settings2, X, ImageIcon, ChevronRight, ChevronDown, Download } from 'lucide-react';
import Scanner from './components/Scanner';
import UploadZone from './components/UploadZone';
import { type Segment } from './components/Timeline';
import ManualEditor from './components/ManualEditor';
import { useSegmentHistory } from './hooks/useSegmentHistory';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

declare global {
  interface Window {
    electron?: {
      getFilePath: (file: File) => Promise<string>;
    };
  }
}

// Source structure returned by backend
interface VideoSource {
  filename: string;
  path: string;
  original_path?: string;
  start: number;
  end: number;
  duration: number;
}

function App() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('IDLE');
  const [progress, setProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadEta, setUploadEta] = useState<string>('');
  const [processingEta, setProcessingEta] = useState<string>('');
  const [stepLabel, setStepLabel] = useState<string>('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const {
    segments,
    setSegments,
    undo: undoSegments,
    redo: redoSegments,
    reset: resetSegments,
    canUndo,
    canRedo
  } = useSegmentHistory([]);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [currentSourceIndex, setCurrentSourceIndex] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isManualMode, setIsManualMode] = useState(false);
  const [audioStreams, setAudioStreams] = useState<any[]>([]);
  const [silenceAction, setSilenceAction] = useState<string>('delete');
  const [autoFrame, setAutoFrame] = useState<boolean>(false);
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
  const [vadThreshold, setVadThreshold] = useState<number>(0.35);
  const [isAggressive, setIsAggressive] = useState<boolean>(false);
  const [leadingPadding, setLeadingPadding] = useState<number>(0.08);
  const [trailingPadding, setTrailingPadding] = useState<number>(0.08);
  const [minSilenceDuration, setMinSilenceDuration] = useState<number>(0.2);
  const [minSpeechDuration, setMinSpeechDuration] = useState<number>(0.3);
  const [fatalError, setFatalError] = useState<any>(null);

  // --- MEMORY LEAK PREVENTION (Intervals & Blob URLs) ---
  const pollIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    // Cleanup dangling ObjectURLs when sources change or unmount
    return () => {
      sources.forEach(src => {
        if (src.path.startsWith('blob:')) {
          URL.revokeObjectURL(src.path);
        }
      });
    };
  }, [sources]);

  useEffect(() => {
    // Cleanup polling interval on unmount
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const [maxSilenceDuration, setMaxSilenceDuration] = useState<number>(5.0);
  const [maxSpeechDuration, setMaxSpeechDuration] = useState<number>(10.0);
  const [useTurbo, setUseTurbo] = useState<boolean>(true);
  const [gpuType, setGpuType] = useState<string>('none');
  const [showAdvancedAuth, setShowAdvancedAuth] = useState<boolean>(false);
  const [mergeOnly, setMergeOnly] = useState<boolean>(false);
  const [aspectRatio, setAspectRatio] = useState<string>('original');
  // Export feedback state
  const [exportingLabel, setExportingLabel] = useState<string | null>(null);
  const [exportDone, setExportDone] = useState<string | null>(null);

  // Derived: current source being played
  const currentSource = sources[currentSourceIndex] || null;

  // When sources load, set duration to total virtual timeline length
  useEffect(() => {
    if (sources.length > 0) {
      setDuration(sources[sources.length - 1].end);
      setCurrentSourceIndex(0);
    }
  }, [sources]);

  // Ensure segments array includes explicit "cut" gaps for the UI
  useEffect(() => {
    if (segments.length === 0 || duration === 0) return;
    if (segments.some(s => s.type === 'cut')) return;

    const filled: Segment[] = [];
    let t = 0;
    const sorted = [...segments].sort((a, b) => a.start - b.start);

    sorted.forEach(s => {
      if (s.start > t + 0.1) {
        filled.push({ start: t, end: s.start, type: 'cut' });
      }
      filled.push({ ...s, type: 'keep' });
      t = s.end;
    });

    if (t < duration) {
      filled.push({ start: t, end: duration, type: 'cut' });
    }

    if (filled.length !== segments.length) {
      setSegments(filled);
    }
  }, [segments, duration]);

  // When currentSourceIndex changes, load that source into the video element
  useEffect(() => {
    if (!videoRef.current || sources.length === 0) return;
    const src = sources[currentSourceIndex];
    if (!src) return;
    videoRef.current.src = src.path;
    videoRef.current.load();
    // Don't auto-play on index change — let user control playback
  }, [currentSourceIndex, sources]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatTime = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleFileSelect = (files: File[]) => {
    setSelectedFiles(prev => [...prev, ...files]);
    setErrorMessage('');
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleDragStartItem = (index: number) => {
    setDraggedItemIndex(index);
  };

  const handleDragOverItem = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDropItem = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedItemIndex === null || draggedItemIndex === dropIndex) return;
    const newFiles = [...selectedFiles];
    const draggedFile = newFiles[draggedItemIndex];
    newFiles.splice(draggedItemIndex, 1);
    newFiles.splice(dropIndex, 0, draggedFile);
    setSelectedFiles(newFiles);
    setDraggedItemIndex(null);
  };

  const startProcessing = async () => {
    if (selectedFiles.length === 0) return;
    setIsUploading(true);
    setStatus('UPLOADING');
    setUploadProgress(0);
    setUploadEta('calculating...');
    setErrorMessage('');

    try {
      if (window.electron) {
        setUploadEta('Getting file paths...');
        const filePaths = [];
        for (const file of selectedFiles) {
          const path = await window.electron.getFilePath(file);
          filePaths.push(path);
        }

        setUploadProgress(100);
        setStatus('PROCESSING');
        setUploadEta('Starting local processing...');

        const res = await fetch('http://localhost:8000/process_local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths }),
        });

        const data = await res.json();
        if (data.status === 'error') throw new Error(data.message);

        setFileId(data.file_id);

        if (data.audio_streams && data.audio_streams.length > 1) {
          setAudioStreams(data.audio_streams);
          setStatus('SELECT_AUDIO');
          setIsUploading(false);
          setUploadProgress(100);
          setUploadEta('');
          return;
        }

        await fetch('http://localhost:8000/analyze_project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_id: data.file_id,
            audio_stream_index: -1,
            settings: {
              vad_threshold: isAggressive ? 0.6 : vadThreshold,
              pad_start: leadingPadding,
              pad_end: trailingPadding,
              min_silence_duration_ms: minSilenceDuration * 1000,
              min_speech_duration_ms: minSpeechDuration * 1000,
              max_silence_duration_ms: maxSilenceDuration * 1000,
              max_speech_duration_ms: maxSpeechDuration * 1000,
              use_gpu: gpuType,
              use_turbo: useTurbo && gpuType === 'none' && !mergeOnly,
              merge_only: mergeOnly
            }
          })
        });

        startPolling(data.file_id);
        setStatus('PROCESSING');
        setIsUploading(false);
        setUploadProgress(100);
        setUploadEta('');
        return;
      }

      // Browser fallback — single file only
      if (selectedFiles.length > 1) {
        alert('Multi-file merge requires the Desktop App.');
        setIsUploading(false);
        setStatus('IDLE');
        return;
      }

      const file = selectedFiles[0];
      const CHUNK_SIZE = 1024 * 1024;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const startTime = Date.now();

      const initRes = await fetch('http://localhost:8000/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, fileSize: file.size }),
      });
      const initData = await initRes.json();
      const uploadFileId = initData.file_id;

      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      const sendChunk = (chunkIndex: number): Promise<void> => {
        return new Promise((resolve, reject) => {
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const blob = file.slice(start, end);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `http://localhost:8000/upload/chunk/${uploadFileId}`, true);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const sent = start + e.loaded;
              const pct = (sent / file.size) * 100;
              setUploadProgress(Math.round(pct));
              const elapsed = (Date.now() - startTime) / 1000;
              if (pct > 1) {
                const rem = ((elapsed / pct) * 100) - elapsed;
                setUploadEta(`${formatFileSize(sent)} / ${formatFileSize(file.size)} — ${formatEta(rem)}`);
              }
            }
          };
          xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Chunk ${xhr.status}`));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(blob);
        });
      };

      for (let i = 0; i < totalChunks; i++) { await sendChunk(i); await sleep(50); }
      await fetch(`http://localhost:8000/upload/complete/${uploadFileId}`, { method: 'POST' });

      setFileId(uploadFileId);
      setStatus('PROCESSING');
      setIsUploading(false);
      setUploadProgress(100);
      setUploadEta('');
      startPolling(uploadFileId);

    } catch (err: any) {
      console.error('Upload/Process failed', err);
      setStatus('ERROR');
      setErrorMessage(err.message || 'An unexpected error occurred');
      setIsUploading(false);
    }
  };

  const formatEta = (seconds: number): string => {
    if (seconds < 0 || seconds > 86400) return 'calculating...';
    seconds = Math.round(seconds);
    if (seconds < 60) return `${seconds}s left`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s left`;
    return `${Math.floor(m / 60)}h ${m % 60}m left`;
  };

  const getStepLabel = (step: string): string => {
    const labels: Record<string, string> = {
      initializing: 'Initializing...',
      audio_extraction: 'Extracting Audio',
      vad_analysis: 'Analyzing Speech',
      rendering: 'Rendering Video',
      complete: 'Complete!',
      error: 'Error',
      cancelled: 'Cancelled'
    };
    return labels[step] || step;
  };

  const handleCancel = async () => {
    if (!fileId) return;
    try {
      await fetch(`http://localhost:8000/cancel/${fileId}`, { method: 'POST' });
      setStatus('IDLE');
      setStepLabel('');
      setProgress(0);
    } catch (err) { console.error('Failed to cancel:', err); }
  };

  const handleReset = async () => {
    if (fileId) {
      try { await fetch(`http://localhost:8000/cleanup/${fileId}`, { method: 'POST' }); }
      catch (e) { console.error('Cleanup failed:', e); }
    }
    if (downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(downloadUrl);
    setFileId(null);
    setDownloadUrl(null);
    setStatus('IDLE');
    setProgress(0);
    setProcessingEta('');
    setStepLabel('');
    setUploadEta('');
    setSelectedFiles([]);
    setErrorMessage('');
    setAudioStreams([]);
    resetSegments([]);
    setSources([]);
    setCurrentTime(0);
    setDuration(0);
    setCurrentSourceIndex(0);
    setExportingLabel(null);
    setExportDone(null);
  };

  const startPolling = (fid: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:8000/status/${fid}`);
        if (!res.ok) { if (res.status === 404) return; throw new Error(`HTTP ${res.status}`); }
        const data = await res.json();

        if (data.status === 'error' || data.step === 'error') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          if (data.log_path) {
            setFatalError(Object.assign(new Error(data.message || 'Fatal Backend Crash'), { logPath: data.log_path }));
            return;
          }
          setStatus('ERROR');
          setErrorMessage(data.message || data.details || 'Processing error');
          return;
        }

        if (data.progress !== undefined) setProgress(data.progress);
        if (data.step) { setStatus(data.step); setStepLabel(getStepLabel(data.step)); }
        if (data.eta_display !== undefined) {
          setProcessingEta(data.eta_display);
        } else if (data.step === 'complete') {
          setProcessingEta('');
        }

        if (data.step === 'analysis_complete') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          fetchSegments(fid);
          setStatus('TIMELINE');
        }

        if (data.step === 'complete' && data.output_file) {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setDownloadUrl(`http://localhost:8000/download/${data.output_file}`);
          setStatus('COMPLETE');
        }

      } catch (e) {
        // Suppress console.error in production, strict auditing rule applied.
      }
    }, 1000);
  };

  const fetchSegments = async (fid: string) => {
    try {
      const res = await fetch(`http://localhost:8000/project/${fid}`);
      const data = await res.json();
      if (data.segments) resetSegments(data.segments);
      if (data.sources) setSources(data.sources as VideoSource[]);
    } catch (e) {
      // Suppress network errors on fetch, the user will see a failure state if critical.
    }
  };

  // ── EXPORT HELPERS ──────────────────────────────────────────────────────────
  // All three metadata exports show a brief "Exporting…" banner, then "Done ✓"
  // They do NOT navigate away — they are silent background downloads while you
  // stay on the timeline. Only "Export Video" triggers the processing view.

  const runExport = async (label: string, fetchFn: () => Promise<void>) => {
    setExportingLabel(label);
    setExportDone(null);
    try {
      await fetchFn();
      setExportDone(`${label} downloaded ✓`);
    } catch (e: any) {
      setExportDone(`${label} failed: ${e.message}`);
    } finally {
      setExportingLabel(null);
      setTimeout(() => setExportDone(null), 4000);
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.URL.revokeObjectURL(url), 200);
  };

  const handleExportEDL = () => runExport('EDL', async () => {
    const res = await fetch('http://localhost:8000/export_edl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, segments, settings: {} })
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    triggerDownload(await res.blob(), `project_${fileId}.edl`);
  });

  const handleExportFCPXML = () => runExport('FCPXML', async () => {
    const res = await fetch('http://localhost:8000/export_fcpxml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, segments, settings: {} })
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    triggerDownload(await res.blob(), `project_${fileId}.fcpxml`);
  });

  const handleExportChapters = () => runExport('Chapters (Whisper AI — may take several minutes on CPU…)', async () => {
    const controller = new AbortController();
    // 10-minute hard timeout matching the backend
    const timer = setTimeout(() => controller.abort(), 600_000);
    try {
      const res = await fetch('http://localhost:8000/extract_chapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, segments, settings: {} }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || 'Chapter extraction failed');
      const text = data.chapters.map((ch: any) => {
        const mm = Math.floor(ch.time / 60).toString().padStart(2, '0');
        const ss = Math.floor(ch.time % 60).toString().padStart(2, '0');
        return `${mm}:${ss} ${ch.title}`;
      }).join('\n');
      triggerDownload(new Blob([text], { type: 'text/plain' }), `chapters_${fileId}.txt`);
    } finally {
      clearTimeout(timer);
    }
  });


  // Render video: transitions to processing view
  const handleExport = async () => {
    if (!fileId) return;
    setStatus('RENDERING');
    try {
      await fetch('http://localhost:8000/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fileId,
          segments,
          settings: {
            silence_action: silenceAction,
            auto_frame: autoFrame,
            use_gpu: mergeOnly ? 'none' : gpuType,
            use_turbo: mergeOnly ? false : useTurbo,
            aspect_ratio: aspectRatio,
            merge_only: mergeOnly
          }
        }),
      });
      startPolling(fileId);
    } catch (e: any) {
      console.error('Export failed', e);
      setStatus('ERROR');
      setErrorMessage(e.message || 'Export failed');
    }
  };

  const onTimeUpdate = () => {
    if (videoRef.current && currentSource) {
      setCurrentTime(currentSource.start + videoRef.current.currentTime);
    }
  };

  const onLoadedMetadata = () => {
    // Duration per-source comes from backend; total is already set from sources array
  };

  // Advance to next source when current one ends
  const onVideoEnded = () => {
    const nextIdx = currentSourceIndex + 1;
    if (nextIdx < sources.length) {
      setCurrentSourceIndex(nextIdx);
      setCurrentTime(sources[nextIdx].start);
      // Explicitly load and play the next source
      if (videoRef.current) {
        videoRef.current.src = sources[nextIdx].path;
        videoRef.current.load();
        videoRef.current.play().catch(console.error);
      }
    }
  };

  // Determine if we should show the processing scanner
  const showScanner = ['PROCESSING', 'RENDERING', 'ERROR', 'vad_analysis', 'audio_extraction', 'rendering', 'initializing'].includes(status);

  if (fatalError) {
    throw fatalError;
  }

  return (
    <div className="min-h-screen w-full bg-bg-dark text-white flex flex-col items-center p-6 font-sans">

      {/* Top Navigation */}
      <header className="w-full max-w-5xl flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 flex items-center justify-center -rotate-45">
            <Scissors className="w-6 h-6 text-brand-indigo" />
          </div>
          <span className="font-bold text-lg tracking-tight">Silent Cutter</span>
        </div>
      </header>

      {/* Manual Editor fullscreen overlay */}
      {isManualMode && fileId && (
        <div className="fixed inset-0 z-50 bg-bg-dark">
          <ManualEditor
            fileId={fileId}
            duration={duration}
            segments={segments}
            onSegmentsChange={setSegments}
            aspectRatio={aspectRatio}
            setAspectRatio={setAspectRatio}
            onUndo={undoSegments}
            onRedo={redoSegments}
            canUndo={canUndo}
            canRedo={canRedo}
            sources={sources}
            currentTime={currentTime}
            onSeek={(t: number) => {
              const targetSrc = sources.find(s => t >= s.start && t < s.end);
              if (targetSrc) {
                const targetIdx = sources.indexOf(targetSrc);
                if (targetIdx !== currentSourceIndex) {
                  setCurrentSourceIndex(targetIdx);
                  if (videoRef.current) {
                    videoRef.current.src = targetSrc.path;
                    videoRef.current.load();
                  }
                }
                if (videoRef.current) videoRef.current.currentTime = t - targetSrc.start;
              }
              setCurrentTime(t);
            }}
            onExit={() => setIsManualMode(false)}
          />
        </div>
      )}

      <div className={`w-full max-w-5xl space-y-8 ${isManualMode ? 'hidden' : ''}`}>
        <main className="w-full flex flex-col items-center">

          {/* IDLE / UPLOADING */}
          {(status === 'IDLE' || status === 'UPLOADING') && (
            <div className="w-full max-w-2xl flex flex-col items-center">
              <UploadZone
                onFileSelect={handleFileSelect}
                isUploading={isUploading}
                uploadProgress={uploadProgress}
                uploadEta={uploadEta}
              />

              {selectedFiles.length > 0 && !isUploading && (
                <div className="w-full mt-8 animate-fade-in flex flex-col gap-6">

                  {/* File Queue */}
                  <div className="w-full">
                    <div className="flex justify-between items-center mb-3 px-2">
                      <h3 className="text-xs font-bold text-text-dim tracking-wider uppercase">File Queue</h3>
                      <button onClick={() => setSelectedFiles([])} className="text-xs font-bold text-cut bg-cut/10 hover:bg-cut/20 px-3 py-1 rounded-full transition">
                        {selectedFiles.length} {selectedFiles.length === 1 ? 'File' : 'Files'} • Clear
                      </button>
                    </div>

                    <ul className="space-y-3">
                      {selectedFiles.map((file, i) => (
                        <li
                          key={`${file.name}-${i}`}
                          draggable
                          onDragStart={() => handleDragStartItem(i)}
                          onDragOver={handleDragOverItem}
                          onDrop={(e) => handleDropItem(e, i)}
                          className={`flex items-center gap-4 bg-bg-card border border-border-subtle p-3 rounded-2xl transition cursor-grab ${draggedItemIndex === i ? 'opacity-50 ring-2 ring-brand-indigo' : 'hover:border-border-subtle/80'}`}
                        >
                          <div className="text-text-dim/30 px-1 cursor-grab">
                            ⋮⋮
                          </div>

                          <div className="w-12 h-12 bg-bg-dark rounded-xl flex items-center justify-center border border-border-subtle shrink-0">
                            <ImageIcon className="w-6 h-6 text-text-dim" />
                          </div>

                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{file.name}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-bold text-brand-indigo bg-brand-indigo/10 px-2 py-0.5 rounded uppercase tracking-wider">Ready</span>
                              <span className="text-xs text-text-dim">{formatFileSize(file.size)}</span>
                            </div>
                          </div>

                          <button onClick={() => removeFile(i)} className="w-8 h-8 flex items-center justify-center text-text-dim hover:text-cut transition hover:bg-bg-dark rounded-full">
                            <X className="w-4 h-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Settings Accordion */}
                  <div className="bg-bg-card rounded-2xl border border-border-subtle overflow-hidden">
                    <button
                      onClick={() => setShowAdvancedAuth(!showAdvancedAuth)}
                      className="w-full flex justify-between items-center p-5 font-bold hover:bg-bg-card-hover transition"
                    >
                      <div className="flex items-center gap-3">
                        <Settings2 className="w-5 h-5 text-brand-indigo" />
                        <span>Advanced Settings</span>
                      </div>
                      {showAdvancedAuth ? <ChevronDown className="w-5 h-5 text-text-dim" /> : <ChevronRight className="w-5 h-5 text-text-dim" />}
                    </button>

                    {showAdvancedAuth && (
                      <div className="p-5 pt-0 space-y-6">
                        {/* Threshold Slider */}
                        <div className="space-y-3">
                          <div className="flex justify-between text-sm">
                            <span className="text-text-dim">VAD Threshold</span>
                            <span className="font-mono font-bold text-brand-indigo">{vadThreshold.toFixed(2)}</span>
                          </div>
                          <input
                            type="range"
                            min="0.1" max="0.9" step="0.05"
                            value={vadThreshold}
                            onChange={(e) => setVadThreshold(parseFloat(e.target.value))}
                            className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                          />
                        </div>

                        {/* Speech & Silence Sliders */}
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Min Silence (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{minSilenceDuration.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="0.1" max="2.0" step="0.1"
                              value={minSilenceDuration}
                              onChange={(e) => setMinSilenceDuration(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Min Speech (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{minSpeechDuration.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="0.1" max="2.0" step="0.1"
                              value={minSpeechDuration}
                              onChange={(e) => setMinSpeechDuration(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                        </div>

                        {/* Max Speech & Silence Sliders */}
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Max Silence (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{maxSilenceDuration.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="1.0" max="20.0" step="0.5"
                              value={maxSilenceDuration}
                              onChange={(e) => setMaxSilenceDuration(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Max Speech (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{maxSpeechDuration.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="2.0" max="60.0" step="1.0"
                              value={maxSpeechDuration}
                              onChange={(e) => setMaxSpeechDuration(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                        </div>

                        {/* Padding Sliders */}
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Lead Pad (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{leadingPadding.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="0" max="1" step="0.05"
                              value={leadingPadding}
                              onChange={(e) => setLeadingPadding(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                          <div className="space-y-3">
                            <div className="flex justify-between text-sm">
                              <span className="text-text-dim">Trail Pad (s)</span>
                              <span className="font-mono font-bold text-brand-indigo">{trailingPadding.toFixed(2)}</span>
                            </div>
                            <input
                              type="range" min="0" max="1" step="0.05"
                              value={trailingPadding}
                              onChange={(e) => setTrailingPadding(parseFloat(e.target.value))}
                              className="w-full h-2 bg-bg-dark rounded-lg appearance-none cursor-pointer accent-brand-indigo"
                            />
                          </div>
                        </div>

                        {/* Toggles */}
                        <div className="space-y-4 pt-4 border-t border-border-subtle">
                          <label className="flex items-center justify-between cursor-pointer group">
                            <div>
                              <p className="font-bold text-sm text-white">Merge Only</p>
                              <p className="text-xs text-text-dim">Merge files without cutting silence</p>
                            </div>
                            <div className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${mergeOnly ? 'bg-brand-indigo' : 'bg-bg-dark border border-border-subtle'}`}>
                              <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out ${mergeOnly ? 'translate-x-6' : 'translate-x-0'}`} />
                            </div>
                            <input type="checkbox" checked={mergeOnly} onChange={(e) => {
                              const checked = e.target.checked;
                              setMergeOnly(checked);
                              if (checked) {
                                setGpuType('none');
                                setUseTurbo(false);
                              }
                            }} className="hidden" />
                          </label>

                          <label className={`flex items-center justify-between group ${mergeOnly ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                            <div>
                              <p className="font-bold text-sm text-white">Aggressive Mode</p>
                              <p className="text-xs text-text-dim">Stronger silence cutting</p>
                            </div>
                            <div className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${isAggressive && !mergeOnly ? 'bg-brand-indigo' : 'bg-bg-dark border border-border-subtle'}`}>
                              <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out ${isAggressive && !mergeOnly ? 'translate-x-6' : 'translate-x-0'}`} />
                            </div>
                            <input type="checkbox" disabled={mergeOnly} checked={isAggressive && !mergeOnly} onChange={(e) => setIsAggressive(e.target.checked)} className="hidden" />
                          </label>

                          <label className={`flex items-center justify-between group ${mergeOnly ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                            <div>
                              <p className="font-bold text-sm text-white">Parallel Processing (Turbo)</p>
                              <p className="text-xs text-text-dim">Process clips simultaneously</p>
                            </div>
                            <div className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${useTurbo && !mergeOnly ? 'bg-brand-indigo' : 'bg-bg-dark border border-border-subtle'}`}>
                              <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out ${useTurbo && !mergeOnly ? 'translate-x-6' : 'translate-x-0'}`} />
                            </div>
                            <input type="checkbox" disabled={mergeOnly} checked={useTurbo && !mergeOnly} onChange={(e) => setUseTurbo(e.target.checked)} className="hidden" />
                          </label>

                          <label className={`flex flex-col group ${mergeOnly ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            <div className="flex justify-between items-center mb-2">
                              <div>
                                <p className="font-bold text-sm text-white">GPU Acceleration</p>
                                <p className="text-xs text-text-dim">Use hardware encoder</p>
                              </div>
                            </div>
                            <select
                              disabled={mergeOnly}
                              value={gpuType}
                              onChange={(e) => setGpuType(e.target.value)}
                              className="bg-bg-dark border border-border-subtle text-white text-sm font-bold rounded-xl px-3 py-2 outline-none focus:border-brand-indigo w-full"
                            >
                              <option value="none">None (CPU ONLY)</option>
                              <option value="nvidia">NVIDIA</option>
                              <option value="amd">AMD</option>
                            </select>
                          </label>
                        </div>

                        {/* Reset Defaults */}
                        <div className="pt-2">
                          <button
                            onClick={() => {
                              setVadThreshold(0.35);
                              setIsAggressive(false);
                              setLeadingPadding(0.08);
                              setTrailingPadding(0.08);
                              setMinSilenceDuration(0.2);
                              setMinSpeechDuration(0.3);
                              setMaxSilenceDuration(5.0);
                              setMaxSpeechDuration(10.0);
                              setUseTurbo(true);
                              setMergeOnly(false);
                              setGpuType('none');
                            }}
                            className="w-full py-2 bg-bg-dark hover:bg-bg-card-hover border border-border-subtle text-text-dim hover:text-white transition rounded-xl text-sm font-bold"
                          >
                            Reset to Defaults
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Start processing button sticky at bottom of queue/settings */}
                  <button
                    onClick={startProcessing}
                    className="w-full mt-4 py-4 bg-brand-indigo hover:bg-brand-indigo-hover text-white rounded-full font-bold text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-[1.02] glow-primary"
                  >
                    <Scissors className="w-5 h-5 -rotate-90" />
                    <span>Start Processing</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* SELECT AUDIO TRACK */}
          {status === 'SELECT_AUDIO' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4 animate-fade-in text-center">
              <h3 className="text-xl font-bold text-indigo-400">Multiple Audio Tracks Detected</h3>
              <p className="text-slate-400 mb-4">Select the primary microphone track for Silence Detection (VAD).</p>
              <div className="grid gap-3">
                {audioStreams.map((stream, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      if (fileId) {
                        setStatus('PROCESSING');
                        fetch('http://localhost:8000/analyze_project', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            file_id: fileId,
                            audio_stream_index: stream.index,
                            settings: {
                              vad_threshold: isAggressive ? 0.6 : vadThreshold,
                              pad_start: leadingPadding,
                              pad_end: trailingPadding,
                              min_silence_duration_ms: minSilenceDuration * 1000,
                              min_speech_duration_ms: minSpeechDuration * 1000,
                              max_silence_duration_ms: maxSilenceDuration * 1000,
                              max_speech_duration_ms: maxSpeechDuration * 1000,
                              use_gpu: gpuType,
                              use_turbo: useTurbo && gpuType === 'none' && !mergeOnly,
                              merge_only: mergeOnly
                            }
                          })
                        }).then(() => startPolling(fileId));
                      }
                    }}
                    className="p-4 rounded-lg border border-slate-700 hover:border-indigo-500 hover:bg-slate-800 transition flex justify-between items-center"
                  >
                    <span className="font-medium text-white">{stream.title || `Track ${idx + 1}`}</span>
                    <span className="text-sm text-slate-500">Codec Index: {stream.index} • {stream.channels} channels</span>
                  </button>
                ))}
              </div>
              <button onClick={handleCancel} className="mt-6 text-sm text-slate-500 hover:text-white transition">Cancel Processing</button>
            </div>
          )}

          {/* PROCESSING / RENDERING / ERROR scanner */}
          {showScanner && (
            <Scanner
              progress={progress}
              status={status}
              stepLabel={stepLabel}
              eta={processingEta}
              errorMessage={errorMessage}
              onCancel={handleCancel}
              onReset={handleReset}
            />
          )}

          {/* TIMELINE VIEW */}
          {status === 'TIMELINE' && fileId && (
            <div className="space-y-6 w-full animate-fade-in">

              {/* Multi-file source indicator */}
              {sources.length > 1 && (
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  {sources.map((src, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setCurrentSourceIndex(idx);
                        setCurrentTime(src.start);
                        if (videoRef.current) {
                          videoRef.current.src = src.path;
                          videoRef.current.load();
                          videoRef.current.play().catch(console.error);
                        }
                      }}
                      className={`px-4 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-2 ${currentSourceIndex === idx ? 'bg-brand-indigo text-white shadow-lg shadow-brand-indigo/30' : 'bg-bg-card text-text-dim hover:bg-bg-card-hover border border-border-subtle'}`}
                    >
                      <span className="w-5 h-5 flex items-center justify-center bg-bg-dark rounded-full text-[10px]">{idx + 1}</span>
                      <span>{src.filename} ({formatTime(src.duration)})</span>
                    </button>
                  ))}
                  <span className="text-xs font-bold text-text-dim ml-2 bg-bg-card px-3 py-1.5 rounded-full border border-border-subtle">
                    Total: {formatTime(duration)}
                  </span>
                </div>
              )}

              {/* Video Player */}
              <div className="relative aspect-video bg-black rounded-[2rem] overflow-hidden border border-border-subtle/50 shadow-2xl">
                <video
                  ref={videoRef}
                  src={currentSource?.path || `http://localhost:8000/stream/${fileId}`}
                  className="w-full h-full object-contain"
                  controls
                  onTimeUpdate={onTimeUpdate}
                  onLoadedMetadata={onLoadedMetadata}
                  onEnded={onVideoEnded}
                />
              </div>


              {/* Export feedback toast */}
              {(exportingLabel || exportDone) && (
                <div className={`flex items-center gap-3 px-5 py-4 rounded-2xl text-sm font-bold shadow-lg ${exportDone?.includes('failed') ? 'bg-cut/20 border border-cut text-cut' : 'bg-bg-card border border-border-subtle text-white'}`}>
                  {exportingLabel && (
                    <>
                      <div className="w-5 h-5 border-2 border-brand-indigo border-t-transparent rounded-full animate-spin" />
                      <span>Exporting {exportingLabel}…</span>
                    </>
                  )}
                  {exportDone && <span>{exportDone}</span>}
                </div>
              )}

              {/* Controls Section */}
              <div className="flex flex-col gap-4">
                <div className="flex gap-6 items-center bg-bg-card p-6 rounded-2xl border border-border-subtle flex-wrap">
                  <div className="flex flex-col space-y-2">
                    <label className="text-sm font-bold text-text-dim tracking-wider uppercase">Silence Action</label>
                    <select
                      value={silenceAction}
                      onChange={(e) => setSilenceAction(e.target.value)}
                      className="bg-bg-dark border border-border-subtle text-white font-bold rounded-xl px-4 py-3 text-sm focus:border-brand-indigo outline-none cursor-pointer"
                    >
                      <option value="delete">Delete (Standard Cut)</option>
                    </select>
                  </div>

                  <div className="flex flex-col justify-end h-full pt-6">
                    <label className="flex items-center gap-3 cursor-pointer group">
                      <div className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${autoFrame ? 'bg-brand-indigo' : 'bg-bg-dark border border-border-subtle'}`}>
                        <div className={`w-4 h-4 rounded-full bg-white shadow-sm transform transition-transform duration-200 ease-in-out ${autoFrame ? 'translate-x-6' : 'translate-x-0'}`} />
                      </div>
                      <span className="text-sm font-bold text-white group-hover:text-brand-indigo transition">Smart Auto-Frame (9:16)</span>
                      <input type="checkbox" checked={autoFrame} onChange={(e) => setAutoFrame(e.target.checked)} className="hidden" />
                    </label>
                  </div>
                </div>

                <div className="flex justify-between items-center bg-bg-card p-4 rounded-2xl border border-border-subtle mt-2">
                  <button onClick={handleReset} className="px-6 py-3 rounded-full border border-border-subtle text-text-dim hover:text-white hover:bg-bg-dark transition font-bold text-sm tracking-wide">
                    Start Over
                  </button>

                  <div className="flex items-center gap-3">
                    <details className="relative group">
                      <summary className="px-6 py-3 bg-bg-dark hover:bg-bg-card-hover text-white rounded-full font-bold transition cursor-pointer list-none flex items-center gap-2 border border-border-subtle select-none text-sm">
                        Pro Exports <ChevronDown className="w-4 h-4 text-text-dim" />
                      </summary>
                      <div className="absolute right-0 bottom-[120%] mb-2 w-56 bg-bg-card border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col z-50 p-2 gap-1">
                        <button onClick={handleExportEDL} disabled={!!exportingLabel} className="px-4 py-3 text-left text-sm font-bold rounded-xl hover:bg-bg-dark transition text-white">
                          {exportingLabel === 'EDL' ? '⏳ Exporting…' : 'Export EDL'}
                        </button>
                        <button onClick={handleExportFCPXML} disabled={!!exportingLabel} className="px-4 py-3 text-left text-sm font-bold rounded-xl hover:bg-bg-dark transition text-white">
                          {exportingLabel === 'FCPXML' ? '⏳ Exporting…' : 'Export FCPXML'}
                        </button>
                        <button onClick={handleExportChapters} disabled={!!exportingLabel} className="px-4 py-3 text-left text-sm font-bold rounded-xl hover:bg-bg-dark transition text-white flex gap-2">
                          <span className="text-brand-indigo">✨</span> {exportingLabel === 'Chapters' ? '⏳ Exporting…' : 'Export Chapters'}
                        </button>
                      </div>
                    </details>

                    <button onClick={() => setIsManualMode(true)} className="px-6 py-3 bg-bg-dark hover:bg-bg-card-hover text-white rounded-full font-bold transition border border-border-subtle text-sm flex items-center gap-2">
                      <Settings2 className="w-4 h-4 text-brand-indigo" />
                      Manual Editor
                    </button>
                    <button
                      onClick={handleExport}
                      className="px-8 py-3 bg-brand-indigo hover:bg-brand-indigo-hover text-white rounded-full font-bold shadow-lg shadow-brand-indigo/30 transition transform hover:scale-105 text-sm glow-primary flex items-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      Export Final Video
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* COMPLETE: download result */}
          {downloadUrl && (
            <div className="flex flex-col items-center gap-8 mt-12 w-full max-w-2xl mx-auto bg-bg-card p-10 rounded-[2rem] border border-border-subtle shadow-2xl animate-fade-in">
              <h2 className="text-3xl font-black text-white tracking-widest uppercase">Render Complete</h2>
              <div className="w-full relative aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-brand-indigo/30 ring-4 ring-brand-indigo/10">
                <video src={downloadUrl} controls className="w-full h-full object-contain" autoPlay />
              </div>
              <div className="flex flex-col gap-4 w-full">
                <a href={downloadUrl} download className="w-full flex items-center justify-center gap-3 px-8 py-4 bg-brand-indigo hover:bg-brand-indigo-hover text-white text-lg font-black rounded-full transition-all shadow-lg shadow-brand-indigo/20 transform hover:-translate-y-1 glow-primary">
                  <Download className="w-6 h-6" />
                  DOWNLOAD MP4
                </a>
                <button onClick={handleReset} className="w-full px-8 py-4 bg-bg-dark hover:bg-bg-card-hover text-text-dim hover:text-white font-bold rounded-full transition border border-border-subtle tracking-widest uppercase text-sm">
                  Start New Project
                </button>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
