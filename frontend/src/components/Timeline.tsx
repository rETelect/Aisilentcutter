import React, { useRef, useEffect, useState } from 'react';

export interface Segment {
    start: number;
    end: number;
    type?: 'keep' | 'cut';
}

interface TimelineProps {
    fileId: string;
    duration: number; // Total duration in seconds
    segments: Segment[];
    onSegmentsChange: (segments: Segment[]) => void;
    currentTime: number;
    onSeek: (time: number) => void;
}

const Timeline: React.FC<TimelineProps> = ({
    fileId,
    duration,
    segments,
    onSegmentsChange,
    currentTime,
    onSeek
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [waveform, setWaveform] = useState<number[]>([]);
    const [loading, setLoading] = useState(true);
    const [zoom, setZoom] = useState(1);

    // Tools: 'pointer' (Seek/Toggle) vs 'range' (Select Interval)
    const [tool, setTool] = useState<'pointer' | 'range'>('pointer');

    // Selection State
    const [selection, setSelection] = useState<{ start: number, end: number } | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<number | null>(null);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === 'r') {
                setTool(t => t === 'pointer' ? 'range' : 'pointer');
            }
            if (e.key === 'Escape') {
                setSelection(null);
                setTool('pointer');
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Initialize segments with gaps filled
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
            onSegmentsChange(filled);
        }
    }, [segments, duration, onSegmentsChange]);

    // Fetch waveform data
    useEffect(() => {
        const fetchWaveform = async () => {
            try {
                const res = await fetch(`http://localhost:8000/project/${fileId}/waveform`);
                const data = await res.json();
                if (data.waveform && Array.isArray(data.waveform)) {
                    setWaveform(data.waveform);
                } else if (Array.isArray(data)) {
                    setWaveform(data);
                }
            } catch (err) {
                console.error("Failed to load waveform", err);
            } finally {
                setLoading(false);
            }
        };
        fetchWaveform();
    }, [fileId]);

    // Draw Canvas
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || waveform.length === 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Handle resize & Zoom
        const containerWidth = container.clientWidth;
        const width = containerWidth * zoom;
        const height = 120;

        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;

        // Clear
        ctx.clearRect(0, 0, width, height);

        // Draw Background
        ctx.fillStyle = '#111115'; // bg-bg-dark
        ctx.fillRect(0, 0, width, height);

        // Draw Waveform
        // --- STYLING CONSTANTS ---
        const BLOCK_H = Math.max(80, height - 30); // Dynamic height to respond to user resize
        const TRACK_Y = (height - BLOCK_H) / 2 + 10;
        ctx.beginPath();
        ctx.strokeStyle = '#2A2A35'; // border-border-subtle
        ctx.lineWidth = 1;

        const step = width / waveform.length;

        waveform.forEach((val, i) => {
            const x = i * step;
            const h = val * (BLOCK_H * 0.8); // Use BLOCK_H for waveform height
            ctx.moveTo(x, TRACK_Y + BLOCK_H / 2 - h / 2);
            ctx.lineTo(x, TRACK_Y + BLOCK_H / 2 + h / 2);
        });
        ctx.stroke();

        // Draw Segments
        segments.forEach(seg => {
            const startX = (seg.start / duration) * width;
            const endX = (seg.end / duration) * width;
            const w = Math.max(endX - startX, 1);

            if (seg.type === 'keep' || !seg.type) {
                ctx.fillStyle = '#00E67633'; // Keep with opacity
                ctx.fillRect(startX, 0, w, height);
                ctx.strokeStyle = '#00E676';
                ctx.strokeRect(startX, 0, w, height);
            } else {
                ctx.fillStyle = '#FF3B3033'; // Cut with opacity
                ctx.fillRect(startX, 0, w, height);
            }
        });

        // Draw Selection Overlay
        if (selection) {
            const startX = (selection.start / duration) * width;
            const endX = (selection.end / duration) * width;
            const selW = endX - startX;
            ctx.fillStyle = '#5442F54D'; // Indigo
            ctx.fillRect(startX, 0, selW, height);
            ctx.strokeStyle = '#5442F5';
            ctx.lineWidth = 2;
            ctx.strokeRect(startX, 0, selW, height);
        }

        // Draw Cursor
        const cursorX = (currentTime / duration) * width;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cursorX, 0);
        ctx.lineTo(cursorX, height);
        ctx.stroke();

    }, [waveform, segments, currentTime, duration, zoom, selection]);

    // Mouse Handlers
    const getTimestamp = (e: React.MouseEvent) => {
        if (!canvasRef.current || duration === 0) return 0;
        const x = e.nativeEvent.offsetX;
        const width = canvasRef.current.width;
        return (x / width) * duration;
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return; // Only left click

        const t = getTimestamp(e);

        if (tool === 'range') {
            setIsDragging(true);
            dragStartRef.current = t;
            if (!e.ctrlKey) setSelection(null);
        } else {
            // Pointer Mode: Seek or Toggle
            // We'll handle Toggle in Click
            // But allow Seek on MouseDown?
            // Standard: Seek on Click/Drag?
            // Let's allow simple Seek.
            onSeek(t);
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (tool === 'range') {
            if (!isDragging || dragStartRef.current === null) return;
            const t = getTimestamp(e);
            const start = Math.min(dragStartRef.current, t);
            const end = Math.max(dragStartRef.current, t);
            setSelection({ start, end });
        } else {
            // Pointer Mode: Maybe dragging scrubbing?
            // Not implemented for MVP simplicity.
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        if (tool === 'range') {
            if (!isDragging) return;
            setIsDragging(false);
            // If tiny drag -> Treat as click?
            if (dragStartRef.current !== null) {
                const t = getTimestamp(e);
                const dist = Math.abs(t - dragStartRef.current);
                if (dist < 0.2) {
                    // Click in Range Mode -> Clear selection
                    setSelection(null);
                }
            }
            dragStartRef.current = null;
        }
    };

    const handleClick = (e: React.MouseEvent) => {
        // This runs AFTER mouseUp
        if (tool === 'pointer') {
            const t = getTimestamp(e);
            const segmentIndex = segments.findIndex(s => t >= s.start && t <= s.end);
            if ((e.ctrlKey || e.metaKey) && segmentIndex !== -1) {
                const newSegments = [...segments];
                const seg = { ...newSegments[segmentIndex] };
                seg.type = (seg.type === 'cut') ? 'keep' : 'cut';
                newSegments[segmentIndex] = seg;
                onSegmentsChange(newSegments);
            } else {
                onSeek(t);
            }
        }
    };

    const handleRangeAction = (actionType: 'keep' | 'cut') => {
        if (!selection) return;

        // Split segments at Start and End
        let newSegments: Segment[] = [];
        const { start, end } = selection;

        const splitAt = (segs: Segment[], t: number): Segment[] => {
            const res: Segment[] = [];
            segs.forEach(s => {
                if (t > s.start && t < s.end) {
                    res.push({ start: s.start, end: t, type: s.type });
                    res.push({ start: t, end: s.end, type: s.type });
                } else {
                    res.push(s);
                }
            });
            return res;
        };

        // 1. Split at Start
        let temp = splitAt(segments, start);
        // 2. Split at End
        temp = splitAt(temp, end);

        // 3. Update types in range
        newSegments = temp.map(s => {
            const mid = (s.start + s.end) / 2;
            if (mid >= start && mid <= end) {
                return { ...s, type: actionType };
            }
            return s;
        });

        onSegmentsChange(newSegments);
        setSelection(null);
        // Switch back to pointer automatically?
        setTool('pointer');
    };

    const handleWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            setZoom(z => Math.max(1, Math.min(20, z + (e.deltaY < 0 ? 0.5 : -0.5))));
            e.preventDefault();
        }
    };

    const zoomIn = () => setZoom(z => Math.min(20, z + 1));
    const zoomOut = () => setZoom(z => Math.max(1, z - 1));

    // Manual Time Input Handlers
    const handleTimeChange = (type: 'start' | 'end', value: string) => {
        if (!selection) return;
        const val = parseFloat(value);
        if (isNaN(val)) return;

        // Validation
        let newStart = selection.start;
        let newEnd = selection.end;

        if (type === 'start') {
            newStart = Math.max(0, val);
            if (newStart >= newEnd) newEnd = newStart + 0.1;
        } else {
            newEnd = Math.min(duration, val);
            if (newEnd <= newStart) newStart = Math.max(0, newEnd - 0.1);
        }

        setSelection({ start: newStart, end: newEnd });
    };

    return (
        <div className="w-full bg-bg-card border border-border-subtle rounded-2xl p-5 space-y-4">
            <div className="flex justify-between items-center text-xs text-text-dim font-bold tracking-wider uppercase">
                <div className="flex gap-3 items-center">
                    <div className="flex items-center gap-1 bg-bg-dark rounded-xl px-2 py-1 border border-border-subtle">
                        <span className="text-[10px] text-text-dim px-2">Zoom:</span>
                        <button onClick={zoomOut} className="w-6 h-6 flex justify-center items-center bg-bg-card rounded shadow-sm hover:bg-bg-card-hover border border-border-subtle transition">-</button>
                        <span className="w-8 text-center text-white">{zoom.toFixed(1)}x</span>
                        <button onClick={zoomIn} className="w-6 h-6 flex justify-center items-center bg-bg-card rounded shadow-sm hover:bg-bg-card-hover border border-border-subtle transition">+</button>
                    </div>

                    {selection && (
                        <>
                            <div className="h-4 w-px bg-border-subtle mx-2"></div>

                            {/* Manual Time Inputs */}
                            <div className="flex items-center gap-2 bg-bg-dark rounded-xl px-3 py-1.5 border border-brand-indigo/50">
                                <span className="text-text-dim">In:</span>
                                <input
                                    type="number"
                                    step="0.1"
                                    className="w-16 bg-transparent text-white font-mono focus:outline-none text-right"
                                    value={selection.start.toFixed(2)}
                                    onChange={(e) => handleTimeChange('start', e.target.value)}
                                />
                                <span className="text-text-dim ml-2 border-l border-border-subtle pl-2">Out:</span>
                                <input
                                    type="number"
                                    step="0.1"
                                    className="w-16 bg-transparent text-white font-mono focus:outline-none text-right"
                                    value={selection.end.toFixed(2)}
                                    onChange={(e) => handleTimeChange('end', e.target.value)}
                                />
                                <span className="text-text-dim ml-1">s</span>
                            </div>

                            <div className="h-4 w-px bg-border-subtle mx-2"></div>

                            <button
                                onClick={() => handleRangeAction('cut')}
                                className="px-3 py-1.5 bg-cut/10 text-cut rounded-lg hover:bg-cut hover:text-white transition font-bold"
                            >
                                Cut Range
                            </button>
                            <button
                                onClick={() => handleRangeAction('keep')}
                                className="px-3 py-1.5 bg-keep/10 text-keep rounded-lg hover:bg-keep hover:text-white transition font-bold"
                            >
                                Keep Range
                            </button>
                            <button
                                onClick={() => setSelection(null)}
                                className="px-3 py-1.5 bg-bg-dark text-text-dim hover:text-white rounded-lg transition"
                            >
                                Clear
                            </button>
                        </>
                    )}
                </div>
                <span className="text-white font-mono text-sm bg-bg-dark px-3 py-1 rounded-lg border border-border-subtle">
                    {Math.floor(duration / 60)}:{Math.floor(duration % 60).toString().padStart(2, '0')}
                </span>
            </div>
            <div
                ref={containerRef}
                onWheel={handleWheel}
                className="w-full min-h-[140px] h-[160px] max-h-[600px] overflow-hidden group relative custom-scrollbar select-none rounded-xl border border-border-subtle/50 bg-bg-dark resize-y p-1"
            >
                {/* Visual Resizer Hint */}
                <div className="absolute bottom-0 right-0 w-4 h-4 cursor-ns-resize opacity-0 group-hover:opacity-100 transition duration-300 pointer-events-none flex items-center justify-center">
                    <svg className="w-3 h-3 text-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l4-4 4 4m0 6l-4 4-4-4" /></svg>
                </div>

                <canvas
                    ref={canvasRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onClick={handleClick}
                    className="w-full h-full block outline-none cursor-pointer"
                />
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-text-dim pointer-events-none drop-shadow-md">
                        Fetching Audio Data...
                    </div>
                )}
            </div>
        </div>
    );
};

export default Timeline;
