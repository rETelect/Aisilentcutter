import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import UploadZone from '../components/UploadZone';

describe('UploadZone Component', () => {
    const mockOnFileSelect = jest.fn();

    beforeEach(() => {
        mockOnFileSelect.mockClear();
    });

    it('renders idle state correctly', () => {
        render(
            <UploadZone
                onFileSelect={mockOnFileSelect}
                isUploading={false}
                uploadProgress={0}
                uploadEta=""
            />
        );

        expect(screen.getByText('Upload Video')).toBeInTheDocument();
        expect(screen.getByText(/MP4, MOV, MKV/)).toBeInTheDocument();
    });

    it('renders uploading state correctly', () => {
        render(
            <UploadZone
                onFileSelect={mockOnFileSelect}
                isUploading={true}
                uploadProgress={45}
                uploadEta="2m 30s left"
            />
        );

        expect(screen.getByText('Uploading Video...')).toBeInTheDocument();
        expect(screen.getByText('45%')).toBeInTheDocument();
        expect(screen.getByText('2m 30s left')).toBeInTheDocument();
    });

    it('handles simulated drag over and drag leave events', () => {
        render(
            <UploadZone
                onFileSelect={mockOnFileSelect}
                isUploading={false}
                uploadProgress={0}
                uploadEta=""
            />
        );

        const dropZone = screen.getByText('Upload Video').closest('div')?.parentElement as HTMLElement;

        // Default class checks
        expect(dropZone).toHaveClass('border-border-subtle');

        fireEvent.dragEnter(dropZone);
        expect(dropZone).toHaveClass('border-indigo-500/50');
        expect(dropZone).toHaveClass('bg-indigo-500/5');

        fireEvent.dragLeave(dropZone);
        expect(dropZone).not.toHaveClass('border-brand-indigo');
    });

    it('triggers onFileSelect when a file is dropped', () => {
        render(
            <UploadZone
                onFileSelect={mockOnFileSelect}
                isUploading={false}
                uploadProgress={0}
                uploadEta=""
            />
        );

        const dropZone = screen.getByText('Upload Video').closest('div')?.parentElement as HTMLElement;

        const file = new File(['dummy content'], 'video.mp4', { type: 'video/mp4' });

        // Mock the event object structure expected by the drop handler
        const dropEvent = new Event('drop', { bubbles: true });
        Object.defineProperty(dropEvent, 'dataTransfer', {
            value: {
                files: [file],
            }
        });

        fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

        expect(mockOnFileSelect).toHaveBeenCalledTimes(1);
        expect(mockOnFileSelect).toHaveBeenCalledWith([file]);
    });
});
