import React, { useCallback, useRef } from 'react';
import { UploadCloud } from 'lucide-react';

interface UploadZoneProps {
    onFileSelect: (files: File[]) => void;
    isUploading: boolean;
    uploadProgress?: number;
    uploadEta?: string;
}

const UploadZone: React.FC<UploadZoneProps> = ({ onFileSelect, isUploading, uploadProgress = 0, uploadEta = '' }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = React.useState(false);

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isUploading) setIsDragging(true);
    }, [isUploading]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            onFileSelect(files);
        }
    }, [onFileSelect]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const files = Array.from(e.target.files);
            onFileSelect(files);
        }
    }, [onFileSelect]);

    const handleBrowseClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            className={`
                w-full border-2 border-dashed rounded-[2rem] flex flex-col items-center justify-center
                transition-all duration-300 relative overflow-hidden
                ${isUploading
                    ? 'border-indigo-500/50 bg-indigo-500/5 h-auto py-12'
                    : isDragging
                        ? 'border-indigo-500/50 bg-indigo-500/5 h-80'
                        : 'border-border-subtle hover:border-indigo-500/50 hover:bg-bg-card-hover h-80 bg-bg-card'
                }
            `}
        >
            <input
                type="file"
                className="hidden"
                id="file-upload"
                ref={fileInputRef}
                accept="video/*"
                multiple
                onChange={handleChange}
                disabled={isUploading}
            />

            {isUploading ? (
                <div className="w-full px-8 flex flex-col items-center gap-6">
                    <div className="w-16 h-16 rounded-full bg-indigo-500/20 flex items-center justify-center mb-2">
                        <UploadCloud className="w-8 h-8 text-brand-indigo" />
                    </div>
                    <p className="text-xl font-bold text-white">
                        Uploading Video...
                    </p>

                    <div className="w-full max-w-md h-2 bg-bg-dark rounded-full overflow-hidden border border-border-subtle">
                        <div
                            className="h-full rounded-full transition-all duration-300 ease-out bg-brand-indigo glow-primary"
                            style={{ width: `${uploadProgress}%` }}
                        />
                    </div>

                    <div className="w-full max-w-md flex justify-between font-mono text-sm">
                        <span className="text-brand-indigo font-bold">{uploadProgress}%</span>
                        <span className="text-text-dim">{uploadEta || 'calculating...'}</span>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center w-full h-full text-center px-6">
                    <div className="w-20 h-20 rounded-full bg-brand-indigo/10 flex items-center justify-center mb-6">
                        <UploadCloud className="w-10 h-10 text-brand-indigo" />
                    </div>
                    <h3 className="text-2xl font-bold text-white mb-2">Upload Video</h3>
                    <p className="text-base font-medium text-text-dim mb-1">
                        Drag & drop or tap to browse
                    </p>
                    <p className="font-mono text-xs text-text-dim/60 uppercase tracking-widest mb-8">
                        Supports MP4, MOV, MKV
                    </p>
                    <button
                        onClick={handleBrowseClick}
                        className="px-8 py-3 bg-brand-indigo hover:bg-brand-indigo-hover text-white rounded-full font-bold text-sm transition-all glow-primary"
                    >
                        Select Files
                    </button>
                </div>
            )}
        </div>
    );
};

export default UploadZone;
