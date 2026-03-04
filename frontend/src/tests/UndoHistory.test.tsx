import { renderHook, act } from '@testing-library/react';
import { useSegmentHistory } from '../hooks/useSegmentHistory';
import { type Segment } from '../components/Timeline';

describe('useSegmentHistory Stack', () => {
    it('properly pushes and pops arrays without state mutation', () => {
        const { result } = renderHook(() => useSegmentHistory([]));

        const s1: Segment[] = [{ start: 0, end: 10, type: 'keep' }];
        const s2: Segment[] = [{ start: 0, end: 10, type: 'keep' }, { start: 10, end: 20, type: 'cut' }];
        const s3: Segment[] = [{ start: 0, end: 5, type: 'keep' }];

        act(() => {
            result.current.setSegments(s1);
        });
        expect(result.current.segments).toBe(s1);
        expect(result.current.state.past).toHaveLength(1);

        act(() => {
            result.current.setSegments(s2);
        });
        expect(result.current.segments).toEqual(s2);

        act(() => {
            result.current.undo();
        });
        // Reference equality check
        expect(result.current.segments).toBe(s1);
        expect(result.current.state.future).toEqual([s2]);

        act(() => {
            result.current.redo();
        });
        expect(result.current.segments).toBe(s2);

        act(() => {
            result.current.setSegments(s3);
        });
        // Setting new state clears future
        expect(result.current.state.future).toHaveLength(0);
        expect(result.current.segments).toEqual(s3);
    });

    it('enforces the 50-step history limit', () => {
        const { result } = renderHook(() => useSegmentHistory([]));

        act(() => {
            for (let i = 0; i < 60; i++) {
                result.current.setSegments([{ start: i, end: i + 1, type: 'keep' }]);
            }
        });

        expect(result.current.state.past.length).toBe(50);
        // After 60 iterations (0 to 59):
        // `present` is iteration 59.
        // `past` holds the 50 strict previous states: iterations 9 through 58.
        // Therefore the oldest state in `past` (index 0) is iteration 9.
        expect(result.current.state.past[0][0].start).toBe(9);
    });
});
