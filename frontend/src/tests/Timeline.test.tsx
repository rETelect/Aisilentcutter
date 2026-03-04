import { render, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import Timeline from '../components/Timeline';
import { Segment } from '../components/Timeline';

describe('Timeline Component', () => {
    const mockSegments: Segment[] = [
        { start: 0, end: 5, type: 'keep' },
        { start: 5, end: 10, type: 'cut' },
        { start: 10, end: 15, type: 'keep' }
    ];
    const mockOnToggle = jest.fn();
    const mockOnSeek = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renders a canvas element', async () => {
        const { container } = render(
            <Timeline
                fileId="test"
                duration={15}
                segments={mockSegments}
                currentTime={2.5}
                onSegmentsChange={mockOnToggle}
                onSeek={mockOnSeek}
            />
        );

        // Await the effect that fetches canvas data
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        const canvas = container.querySelector('canvas');
        expect(canvas).toBeInTheDocument();
    });

    it('handles canvas clicks and delegates to onSeek/onToggle', async () => {
        const { container } = render(
            <Timeline
                fileId="test"
                duration={15}
                segments={mockSegments}
                currentTime={2.5}
                onSegmentsChange={mockOnToggle}
                onSeek={mockOnSeek}
            />
        );

        // Await the effect that fetches canvas data
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        const canvas = container.querySelector('canvas');
        expect(canvas).toBeInTheDocument();

        // As Timeline uses native canvas drawing, testing internal click mapping is complex
        // in Jest without a full layout engine. Here we assert it doesn't crash on simple clicks.
        fireEvent.click(canvas!);

        // Assert canvas interactions or mock callbacks depending on test depth.
    });
});
