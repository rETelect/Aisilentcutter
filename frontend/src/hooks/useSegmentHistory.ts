import { useState, useCallback } from 'react';
import { type Segment } from '../components/Timeline';

export interface SegmentHistoryState {
    past: Segment[][];
    present: Segment[];
    future: Segment[][];
}

export function useSegmentHistory(initialSegments: Segment[] = []) {
    const [state, setState] = useState<SegmentHistoryState>({
        past: [],
        present: initialSegments,
        future: []
    });

    const setSegments = useCallback((newSegments: Segment[]) => {
        setState(prev => {
            // 50-step reference leak prevention: we slice the past array to 50 max
            const newPast = [...prev.past, prev.present].slice(-50);
            return {
                past: newPast,
                present: newSegments,
                future: []
            };
        });
    }, []);

    const undo = useCallback(() => {
        setState(prev => {
            if (prev.past.length === 0) return prev;
            const previous = prev.past[prev.past.length - 1];
            const newPast = prev.past.slice(0, prev.past.length - 1);
            return {
                past: newPast,
                present: previous,
                future: [prev.present, ...prev.future]
            };
        });
    }, []);

    const redo = useCallback(() => {
        setState(prev => {
            if (prev.future.length === 0) return prev;
            const next = prev.future[0];
            const newFuture = prev.future.slice(1);
            return {
                past: [...prev.past, prev.present],
                present: next,
                future: newFuture
            };
        });
    }, []);

    const reset = useCallback((newSegments: Segment[]) => {
        setState({
            past: [],
            present: newSegments,
            future: []
        });
    }, []);

    return {
        state,
        segments: state.present,
        setSegments,
        undo,
        redo,
        reset,
        canUndo: state.past.length > 0,
        canRedo: state.future.length > 0
    };
}
