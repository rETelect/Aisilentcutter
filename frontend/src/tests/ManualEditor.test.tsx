import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ManualEditor from '../components/ManualEditor';
import { type Segment } from '../components/Timeline';

describe('ManualEditor Component', () => {
    const mockSegments: Segment[] = [
        { start: 0, end: 5, type: 'keep' },
        { start: 5, end: 10, type: 'cut' },
        { start: 10, end: 15, type: 'keep' }
    ];

    const mockUndo = jest.fn();
    const mockRedo = jest.fn();
    const mockSetSegments = jest.fn();
    const mockSetAspectRatio = jest.fn();
    const mockOnSeek = jest.fn();
    const mockOnExit = jest.fn();

    const mockSources = [{ filename: 'video.mp4', start: 0, end: 15 }];

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock HTMLMediaElement properties so our video tests don't crash in jsdom
        window.HTMLMediaElement.prototype.play = jest.fn();
        window.HTMLMediaElement.prototype.pause = jest.fn();
        Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
            writable: true,
            value: 15
        });
        Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
            writable: true,
            value: 0
        });
    });

    it('renders correctly', () => {
        render(
            <ManualEditor
                fileId="test-id"
                duration={15}
                segments={mockSegments}
                onSegmentsChange={mockSetSegments}
                aspectRatio="16:9"
                setAspectRatio={mockSetAspectRatio}
                canUndo={false}
                canRedo={false}
                onUndo={mockUndo}
                onRedo={mockRedo}
                sources={mockSources}
                currentTime={0}
                onSeek={mockOnSeek}
                onExit={mockOnExit}
            />
        );
        // Look for essential buttons
        expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /DONE/i })).toBeInTheDocument();
    });

    it('triggers onExit when DONE is clicked', () => {
        render(
            <ManualEditor
                fileId="test-id"
                duration={15}
                segments={mockSegments}
                onSegmentsChange={mockSetSegments}
                aspectRatio="16:9"
                setAspectRatio={mockSetAspectRatio}
                canUndo={false}
                canRedo={false}
                onUndo={mockUndo}
                onRedo={mockRedo}
                sources={mockSources}
                currentTime={0}
                onSeek={mockOnSeek}
                onExit={mockOnExit}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /DONE/i }));
        expect(mockOnExit).toHaveBeenCalledTimes(1);
    });

    it('triggers undo and redo callbacks when buttons clicked', () => {
        render(
            <ManualEditor
                fileId="test-id"
                duration={15}
                segments={mockSegments}
                onSegmentsChange={mockSetSegments}
                aspectRatio="16:9"
                setAspectRatio={mockSetAspectRatio}
                canUndo={true}
                canRedo={true}
                onUndo={mockUndo}
                onRedo={mockRedo}
                sources={mockSources}
                currentTime={0}
                onSeek={mockOnSeek}
                onExit={mockOnExit}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /Undo/i }));
        expect(mockUndo).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: /Redo/i }));
        expect(mockRedo).toHaveBeenCalledTimes(1);
    });
});
