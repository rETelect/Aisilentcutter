import React, { useRef, useEffect, useState } from 'react';
import { type Segment } from './Timeline';

interface ManualEditorProps {
    fileId: string;
    duration: number;
    segments: Segment[];
    onSegmentsChange: (newSegments: Segment[]) => void;
    aspectRatio: string;
    setAspectRatio: (val: string) => void;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    sources: { filename: string; start: number; end: number; path?: string; }[];
    currentTime: number;
    onSeek: (time: number) => void;
    onExit: () => void;
}

const ManualEditor: React.FC<ManualEditorProps> = ({
    fileId,
    duration,
    segments,
    onSegmentsChange,
    aspectRatio,
    setAspectRatio,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    sources,
    currentTime,
    onSeek,
    onExit
}) => {
    // Refs
    const overviewCanvasRef = useRef<HTMLCanvasElement>(null);
    const detailCanvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    // State
    const [waveform, setWaveform] = useState<number[]>([]);
    const [zoom, setZoom] = useState(150); // Default High Zoom (150 PPS)
    const [trackHeight, setTrackHeight] = useState(120); // Default block height
    const [isDragging, setIsDragging] = useState(false);
    const [dragType, setDragType] = useState<'seek' | 'resize-start' | 'resize-end' | null>(null);
    const [dragSegmentIndex, setDragSegmentIndex] = useState<number | null>(null);

    // New Features State
    const [playbackRate, setPlaybackRate] = useState(1);
    const [activeTool, setActiveTool] = useState<'hand' | 'move' | 'cut' | 'delete'>('hand');
    const [isManualSeeking, setIsManualSeeking] = useState(false);
    const [editingScope, setEditingScope] = useState<'all' | number>('all');

    // Scoped Data Derived from Global State
    const scopedSources = editingScope === 'all' ? sources : [sources[editingScope]];
    const scopeStart = editingScope === 'all' ? 0 : sources[editingScope].start;
    const scopeEnd = editingScope === 'all' ? duration : sources[editingScope].end;
    const scopedDuration = scopeEnd - scopeStart;

    const scopedCurrentTime = Math.max(0, Math.min(scopedDuration, currentTime - scopeStart));

    // Virtual waveform (rough approximation since we don't have separate waveforms yet, just global)
    // Actually the waveform is global and array index maps to global duration.
    // For simplicity, we keep waveform mapping global and just offset the drawing.

    const scopedSegments = segments
        .filter(s => s.end > scopeStart && s.start < scopeEnd)
        .map(s => ({
            ...s,
            start: Math.max(0, s.start - scopeStart),
            end: Math.min(scopedDuration, s.end - scopeStart)
        }));

    // Derive current active source based on scoped playhead
    const currentVirtualSource = scopedSources.find(s => scopedCurrentTime >= (s.start - scopeStart) && scopedCurrentTime < (s.end - scopeStart)) || scopedSources[0];

    // Helper to map scoped time modifications back to global time
    const updateGlobalSegments = (newScopedSegments: Segment[]) => {
        const globalSegmentsOutsideScope = segments.filter(s => s.end <= scopeStart || s.start >= scopeEnd);
        const mappedGlobalSegments = newScopedSegments.map(s => ({
            ...s,
            start: s.start + scopeStart,
            end: s.end + scopeStart
        }));

        const combined = [...globalSegmentsOutsideScope, ...mappedGlobalSegments].sort((a, b) => a.start - b.start);
        onSegmentsChange(combined);
    };

    // Fetch Waveform & Metadata
    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Waveform
                const resWave = await fetch(`http://localhost:8000/project/${fileId}/waveform`);
                const dataWave = await resWave.json();
                if (dataWave.waveform && Array.isArray(dataWave.waveform)) {
                    setWaveform(dataWave.waveform);
                } else if (Array.isArray(dataWave)) {
                    setWaveform(dataWave);
                }
            } catch (err) {
                console.error("Failed to load project data", err);
            }
        };
        fetchData();
    }, [fileId]);

    const getSourceName = (time: number) => {
        const globalTime = time + scopeStart;
        const src = sources.find(s => globalTime >= s.start && globalTime < s.end);
        return src ? src.filename : 'Unknown Source';
    };

    // Sync external currentTime -> internal video (mapped to virtual current source)
    useEffect(() => {
        if (!videoRef.current || !currentVirtualSource) return;
        const localTime = scopedCurrentTime - (currentVirtualSource.start - scopeStart);
        if (Math.abs(videoRef.current.currentTime - localTime) > 0.5) {
            videoRef.current.currentTime = localTime;
        }
    }, [scopedCurrentTime, currentVirtualSource, scopeStart]);

    // Sync Playback Rate
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.playbackRate = playbackRate;
        }
    }, [playbackRate]);

    // Keyboard listeners for Undo/Redo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    onRedo();
                } else {
                    onUndo();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onUndo, onRedo]);

    // --- RENDERING ---

    // 1. Overview Timeline (Top Strip)
    useEffect(() => {
        const canvas = overviewCanvasRef.current;
        if (!canvas || scopedDuration === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Auto-resize
        canvas.width = canvas.parentElement?.clientWidth || 800;
        canvas.height = canvas.parentElement?.clientHeight || 48;

        const width = canvas.width;
        const height = canvas.height;

        // Background
        ctx.fillStyle = '#111115'; // bg-bg-dark
        ctx.fillRect(0, 0, width, height);

        // Draw Segments (Mini Blocks)
        scopedSegments.forEach(seg => {
            const startX = (seg.start / scopedDuration) * width;
            const endX = (seg.end / scopedDuration) * width;
            const w = Math.max(endX - startX, 2);

            if (seg.type === 'cut') {
                ctx.fillStyle = '#FF3B30'; // Cut
            } else {
                ctx.fillStyle = '#00E676'; // Keep
            }
            ctx.fillRect(startX, 2, w, height - 4);
        });

        // Viewport Indicator (The "Box")
        if (containerRef.current) {
            const visibleDuration = (containerRef.current.clientWidth / zoom);
            const viewStart = scopedCurrentTime - (visibleDuration / 2);
            const viewX = (Math.max(0, viewStart) / scopedDuration) * width;
            const viewW = (visibleDuration / scopedDuration) * width;

            const rectX = viewX;
            const rectW = Math.max(4, viewW);

            // Translucent Fill
            ctx.fillStyle = '#5442F533'; // Indigo transparent
            ctx.fillRect(rectX, 1, rectW, height - 2);

            // Border
            ctx.strokeStyle = '#5442F5'; // Indigo
            ctx.lineWidth = 2;
            ctx.strokeRect(rectX, 1, rectW, height - 2);
        }

        // Playhead Line
        const playheadX = (scopedCurrentTime / scopedDuration) * width;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(playheadX - 1, 0, 2, height);

    }, [scopedSegments, scopedDuration, scopedCurrentTime, zoom]);


    // 2. Workspace Timeline (Bottom Detail)
    useEffect(() => {
        const canvas = detailCanvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || scopedDuration === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Size
        const width = container.clientWidth;
        const height = canvas.height = container.clientHeight;
        canvas.width = width;

        const centerX = width / 2;
        // Visible Time Range
        const timeWindowHalf = (width / 2) / zoom;
        const startTime = scopedCurrentTime - timeWindowHalf;
        const endTime = scopedCurrentTime + timeWindowHalf;

        // --- STYLING CONSTANTS ---
        const BG_COLOR = '#111115'; // bg-bg-dark
        const RULER_H = 30;
        const BLOCK_H = trackHeight; // Dynamic height
        const TRACK_Y = (height - BLOCK_H) / 2 + 10;

        // Clear
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, width, height);

        // A. PRE-CALCULATE WAVEFORM PATH (Filled "DaVinci" Style)
        const wavePath = new Path2D();
        if (waveform.length > 0) {
            const globalDuration = duration;
            const samplesPerSec = waveform.length / globalDuration;

            const globalStartTime = startTime + scopeStart;
            const globalEndTime = endTime + scopeStart;

            const startIdx = Math.max(0, Math.floor(globalStartTime * samplesPerSec));
            const endIdx = Math.min(waveform.length, Math.ceil(globalEndTime * samplesPerSec));

            const WAVE_Y = TRACK_Y + BLOCK_H / 2; // Data centered in block
            const MAX_WAVE_H = BLOCK_H * 0.95; // 95% of block height (Maximized)

            // 1. Top Half
            const t0 = (startIdx / waveform.length) * globalDuration - scopeStart;
            wavePath.moveTo(centerX + (t0 - scopedCurrentTime) * zoom, WAVE_Y);

            for (let i = startIdx; i < endIdx; i++) {
                const t = (i / waveform.length) * globalDuration - scopeStart;
                const x = centerX + (t - scopedCurrentTime) * zoom;
                const amp = waveform[i] * MAX_WAVE_H;
                wavePath.lineTo(x, WAVE_Y - amp / 2);
            }

            // 2. Bottom Half (Mirror) backwards
            for (let i = endIdx - 1; i >= startIdx; i--) {
                const t = (i / waveform.length) * globalDuration - scopeStart;
                const x = centerX + (t - scopedCurrentTime) * zoom;
                const amp = waveform[i] * MAX_WAVE_H;
                wavePath.lineTo(x, WAVE_Y + amp / 2);
            }

            wavePath.closePath();
        }

        // B. RENDER SEGMENTS (Clipped Waveforms)
        scopedSegments.forEach((seg, idx) => {
            // Visibility Check
            if (seg.end < startTime || seg.start > endTime) return;

            const x1 = centerX + (seg.start - scopedCurrentTime) * zoom;
            const x2 = centerX + (seg.end - scopedCurrentTime) * zoom;
            const w = Math.max(x2 - x1, 0);

            // Styling
            const isCut = seg.type === 'cut';
            const bgColor = isCut ? '#FF3B301A' : '#00E6761A'; // 10% opacity
            const borderColor = isCut ? '#FF3B30' : '#00E676';

            ctx.save();

            // 1. Clip to Segment Box
            ctx.beginPath();
            ctx.rect(x1, TRACK_Y, w, BLOCK_H);
            ctx.clip();

            // 2. Fill Background
            ctx.fillStyle = bgColor;
            ctx.fillRect(x1, TRACK_Y, w, BLOCK_H);

            // 3. Draw Waveform (Clipped & Filled)
            ctx.fillStyle = isCut ? '#FF3B3080' : '#00E67680'; // 50% opacity wave

            ctx.fill(wavePath);

            ctx.restore();

            // 4. Draw Border
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 2;
            ctx.strokeRect(x1, TRACK_Y, w, BLOCK_H);

            // 5. Handles
            const handleW = 6;
            ctx.fillStyle = '#ffffff';

            // Start Handle
            ctx.beginPath();
            ctx.roundRect(x1, TRACK_Y, handleW, BLOCK_H, [4, 0, 0, 4]);
            ctx.fill();

            // End Handle
            ctx.beginPath();
            ctx.roundRect(x2 - handleW, TRACK_Y, handleW, BLOCK_H, [0, 4, 4, 0]);
            ctx.fill();

            // 6. Labels
            if (w > 50) {
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 12px sans-serif';
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 2;

                const label = isCut ? 'CUT / DELETE' : `ACTION ${idx + 1}`;
                ctx.fillText(label, x1 + 10, TRACK_Y + 18);

                const dur = (seg.end - seg.start).toFixed(1) + 's';
                ctx.font = '10px monospace';
                ctx.fillStyle = '#e5e7eb';
                ctx.fillText(dur, x1 + 10, TRACK_Y + 32);

                // Source Hint
                const srcName = getSourceName(seg.start);
                ctx.fillStyle = isCut ? '#fca5a5' : '#6ee7b7';
                ctx.fillText(srcName, x1 + 10, TRACK_Y + 46);

                ctx.shadowBlur = 0;
            }
        });

        // C. RULER (Top Overlay)
        // Ruler Background
        ctx.fillStyle = '#050505'; // very dark top
        ctx.fillRect(0, 0, width, RULER_H);
        ctx.strokeStyle = '#2A2A35'; // border-subtle
        ctx.fillStyle = '#888888'; // text-dim
        ctx.font = '10px monospace';
        ctx.beginPath();

        const startSec = Math.floor(startTime);
        const endSec = Math.ceil(endTime);

        for (let t = startSec; t <= endSec; t++) {
            const x = centerX + (t - scopedCurrentTime) * zoom;
            if (x < 0 || x > width) continue;

            // Major Tick
            ctx.moveTo(x, 0); ctx.lineTo(x, 20);
            ctx.fillText(formatTime(t), x + 5, 15);

            // Minor Ticks
            for (let i = 1; i < 5; i++) {
                const mx = x + (i * zoom / 5);
                ctx.moveTo(mx, 15); ctx.lineTo(mx, 20);
            }
        }
        ctx.stroke();


        // D. PLAYHEAD (Fixed Center)
        ctx.strokeStyle = '#5442F5'; // Brand Indigo
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(centerX, 0);
        ctx.lineTo(centerX, height);
        ctx.stroke();

        // Cap
        ctx.fillStyle = '#5442F5';
        ctx.beginPath();
        ctx.moveTo(centerX - 6, 0);
        ctx.lineTo(centerX + 6, 0);
        ctx.lineTo(centerX, 12);
        ctx.fill();

    }, [scopedSegments, scopedDuration, scopedCurrentTime, waveform, zoom, scopeStart, trackHeight]);


    // --- INTERACTIONS ---

    const handleOverviewClick = (e: React.MouseEvent) => {
        const canvas = overviewCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        onSeek(ratio * scopedDuration + scopeStart);
    };

    const handleDetailMouseDown = (e: React.MouseEvent) => {
        const canvas = detailCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const width = rect.width;
        const centerX = width / 2;

        const timeAtMouse = scopedCurrentTime + (mx - centerX) / zoom;

        // CUT TOOL LOGIC
        if (activeTool === 'cut') {
            // Find segment at mouse
            const i = scopedSegments.findIndex(s => timeAtMouse >= s.start && timeAtMouse < s.end);
            if (i !== -1) {
                const seg = scopedSegments[i];
                if (timeAtMouse - seg.start > 0.1 && seg.end - timeAtMouse > 0.1) {
                    const firstHalf = { ...seg, end: timeAtMouse };
                    const secondHalf = { ...seg, start: timeAtMouse };
                    const newSegments = [
                        ...scopedSegments.slice(0, i),
                        firstHalf,
                        secondHalf,
                        ...scopedSegments.slice(i + 1)
                    ];
                    updateGlobalSegments(newSegments);
                }
            }
            return;
        }

        // DELETE TOOL LOGIC
        if (activeTool === 'delete') {
            // Find segment at mouse
            const i = scopedSegments.findIndex(s => timeAtMouse >= s.start && timeAtMouse < s.end);
            if (i !== -1) {
                const newSegments = [
                    ...scopedSegments.slice(0, i),
                    ...scopedSegments.slice(i + 1)
                ];
                updateGlobalSegments(newSegments);
            }
            return;
        }

        // HAND TOOL LOGIC (Navigation Only)
        if (activeTool === 'hand') {
            setDragType('seek');
            setIsDragging(true);
            setIsManualSeeking(true);
            return;
        }

        // MOVE TOOL LOGIC (Editing)
        const HIT_PX = 15;

        for (let i = 0; i < scopedSegments.length; i++) {
            const seg = scopedSegments[i];
            const x1 = centerX + (seg.start - scopedCurrentTime) * zoom;
            const x2 = centerX + (seg.end - scopedCurrentTime) * zoom;

            // Check Start Handle
            if (Math.abs(mx - x1) < HIT_PX) {
                setDragType('resize-start');
                setDragSegmentIndex(i);
                setIsDragging(true);
                return;
            }
            // Check End Handle
            if (Math.abs(mx - x2) < HIT_PX) {
                setDragType('resize-end');
                setDragSegmentIndex(i);
                setIsDragging(true);
                return;
            }
        }

        // If no handle, seek/scrub
        setDragType('seek');
        setIsDragging(true);
        setIsManualSeeking(true); // Pause video during scrub?
    };


    const handleDetailMouseMove = (e: React.MouseEvent) => {
        if (!isDragging) return;

        if (dragType === 'seek') {
            const deltaPx = e.movementX;
            const deltaTime = -(deltaPx / zoom);
            let newTime = Math.max(0, Math.min(scopedDuration, scopedCurrentTime + deltaTime));
            onSeek(newTime + scopeStart);
        } else if (dragSegmentIndex !== null && dragType) {
            // Dragging Handle
            const canvas = detailCanvasRef.current;
            if (!canvas) return;
            const width = canvas.getBoundingClientRect().width;
            const centerX = width / 2;
            const mouseTime = scopedCurrentTime + (e.clientX - canvas.getBoundingClientRect().left - centerX) / zoom;

            const newSegs = [...scopedSegments];
            const seg = { ...newSegs[dragSegmentIndex] };

            if (dragType === 'resize-start') {
                const maxStart = seg.end - 0.1;
                let newStart = Math.min(Math.max(0, mouseTime), maxStart);
                if (dragSegmentIndex > 0) {
                    newStart = Math.max(newStart, newSegs[dragSegmentIndex - 1].end);
                }
                seg.start = newStart;
            } else {
                const minEnd = seg.start + 0.1;
                let newEnd = Math.max(Math.min(scopedDuration, mouseTime), minEnd);
                if (dragSegmentIndex < scopedSegments.length - 1) {
                    newEnd = Math.min(newEnd, newSegs[dragSegmentIndex + 1].start);
                }
                seg.end = newEnd;
            }
            newSegs[dragSegmentIndex] = seg;
            updateGlobalSegments(newSegs);
        }
    };

    const handleDetailMouseUp = () => {
        setIsDragging(false);
        setDragType(null);
        setDragSegmentIndex(null);
        if (isManualSeeking) {
            setIsManualSeeking(false);
            // Optionally auto-play if was playing?
        }
    };

    // --- ACTIONS ---

    // Assuming Segment type is defined elsewhere, e.g., `interface Segment { start: number; end: number; type: string; }`
    // For the purpose of this edit, we'll assume it's available.
    const togglePlay = () => {
        if (videoRef.current) {
            if (videoRef.current.paused) {
                videoRef.current.play();
            } else {
                videoRef.current.pause();
            }
        }
    };

    const handleSplit = () => {
        if (!scopedSegments.length) return;

        // Find segment at scopedCurrentTime
        const idx = scopedSegments.findIndex(s => scopedCurrentTime >= s.start && scopedCurrentTime < s.end);
        if (idx === -1) return; // Cursor not on a segment

        const seg = scopedSegments[idx];

        // Don't split if too close to edges (0.1s guard)
        if (scopedCurrentTime - seg.start < 0.1 || seg.end - scopedCurrentTime < 0.1) return;

        // Create two new segments
        const firstHalf = { ...seg, end: scopedCurrentTime };
        const secondHalf = { ...seg, start: scopedCurrentTime };

        const newSegments = [
            ...scopedSegments.slice(0, idx),
            firstHalf,
            secondHalf,
            ...scopedSegments.slice(idx + 1)
        ];

        updateGlobalSegments(newSegments);
    };

    return (
        <div className="fixed inset-0 z-50 bg-bg-dark flex flex-col text-white font-sans">
            {/* 1. TOP BAR: Title & Zoom */}
            <header className="h-14 bg-bg-card border-b border-border-subtle flex items-center justify-between px-6 select-none shadow-md z-10 transition-all">
                <div className="flex items-center gap-5">
                    <button
                        onClick={onExit}
                        className="text-text-dim hover:text-white transition flex items-center gap-2 text-xs font-black uppercase tracking-widest"
                    >
                        ← Back
                    </button>
                    <div className="h-6 w-px bg-border-subtle"></div>
                    <span className="text-xs font-black tracking-widest text-brand-indigo uppercase">CUT PRO</span>
                </div>

                {/* CENTER: TOOLS & SCOPE */}
                <div className="flex items-center gap-5">
                    {sources.length > 1 && (
                        <select
                            value={editingScope === 'all' ? 'all' : editingScope}
                            onChange={(e) => {
                                const val = e.target.value;
                                if (val === 'all') {
                                    setEditingScope('all');
                                    onSeek(0);
                                } else {
                                    const idx = parseInt(val, 10);
                                    setEditingScope(idx);
                                    onSeek(sources[idx].start);
                                }
                            }}
                            className="bg-bg-dark border border-border-subtle text-text-dim hover:text-white text-xs font-bold px-3 py-1.5 rounded-lg focus:outline-none focus:border-brand-indigo cursor-pointer transition-colors"
                        >
                            <option value="all">Merged Timeline</option>
                            {sources.map((src, idx) => (
                                <option key={idx} value={idx}>{idx + 1}. {src.filename}</option>
                            ))}
                        </select>
                    )}
                    <div className="flex items-center gap-1.5 bg-bg-dark rounded-xl p-1.5 border border-border-subtle">
                        <button
                            onClick={() => setActiveTool('hand')}
                            className={`p-2 rounded-lg transition-colors ${activeTool === 'hand' ? 'bg-white text-black shadow-sm' : 'hover:bg-bg-card-hover text-text-dim hover:text-white'}`}
                            title="Hand / Navigation Tool (H)"
                        >
                            {/* Hand Icon */}
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11"></path></svg>
                        </button>
                        <button
                            onClick={() => setActiveTool('move')}
                            className={`p-2 rounded-lg transition-colors ${activeTool === 'move' ? 'bg-brand-indigo text-white shadow-sm shadow-brand-indigo/30' : 'hover:bg-bg-card-hover text-text-dim hover:text-white'}`}
                            title="Edit / Move Tool (V)"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path></svg>
                        </button>
                        <div className="w-px h-5 bg-border-subtle mx-1"></div>
                        <button
                            onClick={() => setActiveTool('cut')}
                            className={`p-2 rounded-lg transition-colors ${activeTool === 'cut' ? 'bg-cut text-white shadow-sm shadow-cut/30' : 'hover:bg-bg-card-hover text-text-dim hover:text-cut'}`}
                            title="Razor / Cut Tool (C)"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"></path></svg>
                        </button>
                        <button
                            onClick={() => setActiveTool('delete')}
                            className={`p-2 rounded-lg transition-colors ${activeTool === 'delete' ? 'bg-cut text-white shadow-sm shadow-cut/30' : 'hover:bg-bg-card-hover text-text-dim hover:text-cut'}`}
                            title="Delete / Trash Tool (D)"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                </div>

                {/* RIGHT: ZOOM & UNDO */}
                <div className="flex items-center gap-5">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={onUndo}
                            disabled={!canUndo}
                            className="text-text-dim hover:text-white disabled:opacity-30 disabled:hover:text-text-dim transition"
                            title="Undo (Ctrl+Z)"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                        </button>

                        <button
                            onClick={onRedo}
                            disabled={!canRedo}
                            className="text-text-dim hover:text-white disabled:opacity-30 disabled:hover:text-text-dim transition"
                            title="Redo (Ctrl+Shift+Z)"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ transform: 'scaleX(-1)' }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                        </button>
                    </div>


                    <button
                        onClick={onExit}
                        className="px-5 py-2 text-xs font-black tracking-widest uppercase bg-brand-indigo hover:bg-brand-indigo-hover text-white rounded-lg shadow-lg shadow-brand-indigo/30 transition transform hover:-translate-y-0.5"
                    >
                        DONE
                    </button>
                </div>
            </header>

            {/* 2. MAIN CONTENT SPLIT */}
            <div className="flex-1 flex flex-col min-h-0">

                {/* A. VIDEO PREVIEW (Top 50%) */}
                <div className="flex-1 min-h-0 bg-black relative flex flex-col border-b border-border-subtle">
                    <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                        <video
                            ref={videoRef}
                            src={currentVirtualSource?.path || `http://localhost:8000/stream/${fileId}`}
                            className="h-full w-full object-contain"
                            onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()}
                            onTimeUpdate={() => {
                                if (videoRef.current && currentVirtualSource) {
                                    // Update global time using local sub-source time
                                    const localTime = videoRef.current.currentTime;
                                    const nextGlobalTime = currentVirtualSource.start + localTime;

                                    // Make sure we clamp global time if editing a specific scope
                                    if (editingScope !== 'all' && (nextGlobalTime >= scopeEnd || nextGlobalTime < scopeStart)) {
                                        videoRef.current.pause();
                                        onSeek(scopeEnd); // stop at the end of the scoped file
                                        return;
                                    }

                                    if (Math.abs(nextGlobalTime - currentTime) > 0.2) {
                                        onSeek(nextGlobalTime);
                                    }
                                }
                            }}
                            onEnded={() => {
                                // Virtual playlist progression only if scope is "all"
                                if (editingScope === 'all') {
                                    const idx = scopedSources.findIndex(s => s === currentVirtualSource);
                                    if (idx !== -1 && idx < scopedSources.length - 1) {
                                        onSeek(scopedSources[idx + 1].start);
                                        setTimeout(() => videoRef.current?.play(), 50);
                                    }
                                }
                            }}
                        />
                    </div>

                    {/* STANDARD CONTROLS BAR */}
                    <div className="h-16 bg-bg-card border-t border-border-subtle flex items-center px-6 gap-6">
                        {/* Play/Pause/Stop */}
                        <div className="flex gap-2">
                            <button
                                onClick={togglePlay}
                                className="p-2.5 rounded-full hover:bg-bg-card-hover text-white transition-colors bg-bg-dark border border-border-subtle"
                                title="Play/Pause (Space)"
                            >
                                <svg className="w-5 h-5 fill-current text-brand-indigo" viewBox="0 0 24 24">
                                    {videoRef.current && !videoRef.current.paused
                                        ? <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                                        : <path d="M8 5v14l11-7z" />}
                                </svg>
                            </button>

                            <button
                                onClick={() => {
                                    if (videoRef.current) {
                                        videoRef.current.pause();
                                        videoRef.current.currentTime = 0;
                                    }
                                }}
                                className="p-2.5 rounded-full hover:bg-bg-card-hover text-white transition-colors bg-bg-dark border border-border-subtle"
                                title="Stop"
                            >
                                <div className="w-4 h-4 bg-cut rounded-sm"></div>
                            </button>
                        </div>

                        {/* Speed Controls */}
                        <div className="flex items-center bg-bg-dark rounded-lg overflow-hidden border border-border-subtle shadow-inner">
                            {[1, 2, 4].map(rate => (
                                <button
                                    key={rate}
                                    onClick={() => setPlaybackRate(rate)}
                                    className={`px-4 py-1.5 text-xs font-bold transition-colors ${playbackRate === rate ? 'bg-brand-indigo text-white shadow-md shadow-brand-indigo/30' : 'text-text-dim hover:bg-bg-card-hover hover:text-white'}`}
                                >
                                    {rate}x
                                </button>
                            ))}
                        </div>

                        {/* Progress Bar (The "Line") */}
                        <div className="flex-1 flex items-center gap-4 bg-bg-dark px-4 py-1.5 rounded-xl border border-border-subtle shadow-inner">
                            <span className="text-xs font-mono font-bold text-brand-indigo">{formatTime(scopedCurrentTime)}</span>
                            <input
                                type="range"
                                min={0}
                                max={scopedDuration}
                                step={0.01}
                                value={scopedCurrentTime}
                                onChange={(e) => {
                                    const t = parseFloat(e.target.value);
                                    onSeek(t + scopeStart);
                                }}
                                className="flex-1 h-1.5 bg-bg-card rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-brand-indigo [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-125 transition-all outline-none"
                            />
                            <span className="text-xs font-mono font-bold text-text-dim">{formatTime(scopedDuration)}</span>
                        </div>

                        {/* ASPECT RATIO */}
                        <div className="flex items-center gap-3 bg-bg-dark border border-border-subtle px-3 py-1.5 rounded-lg shadow-sm">
                            <span className="text-xs font-black tracking-widest uppercase text-text-dim">FRAME:</span>
                            <select
                                value={aspectRatio}
                                onChange={(e) => setAspectRatio(e.target.value)}
                                className="bg-transparent text-white text-xs font-bold rounded focus:outline-none cursor-pointer [&>option]:bg-bg-dark [&>option]:text-white"
                            >
                                <option value="original">Original</option>
                                <option value="16:9">16:9 (Landscape)</option>
                                <option value="9:16">9:16 (Portrait)</option>
                                <option value="1:1">1:1 (Square)</option>
                                <option value="4:5">4:5 (Vertical)</option>
                            </select>
                        </div>

                        {/* SPLIT TOOL */}
                        <div className="h-8 w-px bg-border-subtle mx-2"></div>
                        <button
                            onClick={handleSplit}
                            className="flex items-center gap-2 px-5 py-2 bg-cut/10 border border-cut/30 hover:bg-cut text-cut hover:text-white rounded-lg font-black tracking-widest text-xs uppercase shadow-md active:transform active:scale-95 transition-all"
                            title="Split Segment at Playhead"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"></path></svg>
                            SPLIT
                        </button>
                    </div>
                </div>

                {/* B. TIMELINE AREA (Bottom Height Fixed) */}
                <div className="h-[280px] shrink-0 flex flex-col bg-[#0A0A10] border-t border-border-subtle">

                    {/* ZOOM & HEIGHT CONTROL BAR */}
                    <div className="h-10 px-4 flex justify-between items-center bg-bg-card border-b border-border-subtle z-20">
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] font-black tracking-widest text-text-dim uppercase">ZOOM:</span>
                                <div className="flex items-center gap-1 bg-bg-dark rounded-md px-1 py-0.5 border border-border-subtle">
                                    <button onClick={() => setZoom(Math.max(0.5, zoom / 1.5))} className="w-5 h-5 flex justify-center items-center hover:bg-bg-card-hover rounded text-text-dim hover:text-white transition-colors text-xs font-bold"> - </button>
                                    <span className="text-xs font-mono font-bold w-10 text-center text-white">{(zoom / 150).toFixed(1)}X</span>
                                    <button onClick={() => setZoom(Math.min(3000, zoom * 1.5))} className="w-5 h-5 flex justify-center items-center hover:bg-bg-card-hover rounded text-text-dim hover:text-white transition-colors text-xs font-bold"> + </button>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 border-l border-border-subtle pl-4">
                                <span className="text-[10px] font-black tracking-widest text-text-dim uppercase">HEIGHT:</span>
                                <div className="flex items-center gap-1 bg-bg-dark rounded-md px-1 py-0.5 border border-border-subtle">
                                    <button onClick={() => setTrackHeight(h => Math.max(20, h - 20))} className="w-5 h-5 flex justify-center items-center hover:bg-bg-card-hover rounded text-text-dim hover:text-white transition-colors text-xs font-bold"> - </button>
                                    <span className="text-xs font-mono font-bold w-10 text-center text-white">{Math.round((trackHeight / 120) * 100)}%</span>
                                    <button onClick={() => setTrackHeight(h => Math.min(260, h + 20))} className="w-5 h-5 flex justify-center items-center hover:bg-bg-card-hover rounded text-text-dim hover:text-white transition-colors text-xs font-bold"> + </button>
                                </div>
                            </div>
                        </div>
                        <div className="text-xs font-mono font-bold text-white bg-bg-dark px-2 py-1 rounded border border-border-subtle shadow-inner">
                            {formatTime(scopedDuration)}
                        </div>
                    </div>

                    {/* B1. OVERVIEW WIDGET */}
                    <div className="h-10 bg-bg-dark border-b border-border-subtle relative cursor-pointer group shadow-md z-10 transition">
                        <canvas
                            ref={overviewCanvasRef}
                            className="w-full h-full block"
                            onMouseDown={handleOverviewClick}
                        />
                    </div>

                    {/* B2. DETAILED EDITOR */}
                    <div
                        ref={containerRef}
                        className="flex-1 relative cursor-ew-resize select-none overflow-hidden bg-bg-dark"
                        onMouseDown={handleDetailMouseDown}
                        onMouseMove={handleDetailMouseMove}
                        onMouseUp={handleDetailMouseUp}
                        onMouseLeave={handleDetailMouseUp}
                        onWheel={(e) => {
                            if (e.ctrlKey) {
                                e.preventDefault();
                                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                                setZoom(z => Math.max(0.5, Math.min(3000, z * delta)));
                            } else {
                                onSeek(currentTime + (e.deltaY / zoom));
                            }
                        }}
                    >
                        <canvas
                            ref={detailCanvasRef}
                            className="w-full h-full block"
                        />
                    </div>
                </div>

            </div>
        </div>
    );
};

// Helper
function formatTime(s: number) {
    if (isNaN(s)) return '0:00';
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${min}:${sec.toString().padStart(2, '0')}.${ms}`;
}

export default ManualEditor;
