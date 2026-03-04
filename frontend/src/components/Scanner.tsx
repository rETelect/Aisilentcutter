import React from 'react';
import { RefreshCw, CheckCircle2, Circle, X } from 'lucide-react';

interface ScannerProps {
  progress: number; // 0 to 100
  status: string;
  stepLabel: string;
  eta?: string;
  errorMessage?: string;
  onCancel?: () => void;
  onReset?: () => void;
}

const Scanner: React.FC<ScannerProps> = ({ progress, status, stepLabel, eta = '', errorMessage, onCancel, onReset }) => {
  const isComplete = status === 'complete';
  const isError = status === 'ERROR' || status === 'error';

  // Steps for the checklist based on the mockups.
  // In a real app we'd map `status` to these steps, but we'll approximate based on progress for now,
  // or use the status string if it matches 'audio_extraction', 'vad_analysis', 'rendering'.
  const currentStepIndex =
    status === 'audio_extraction' ? 0 :
      status === 'vad_analysis' ? 1 :
        status === 'rendering' ? 2 :
          isComplete ? 3 : -1;

  const steps = [
    { label: 'Extract Audio Track' },
    { label: 'Voice Activity Detection' },
    { label: 'Generate Cut List' }
  ];

  // SVG Circular Progress calculation
  const radius = 90;
  const stroke = 12;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="w-full flex flex-col items-center justify-center min-h-[600px] animate-fade-in relative">
      {/* Centered Processing Ring */}
      <div className="relative flex items-center justify-center mb-10 mt-8">
        {/* Background Ring */}
        <svg
          height={radius * 2}
          width={radius * 2}
          className="transform -rotate-90 drop-shadow-2xl"
        >
          <circle
            stroke="#1A1A24"
            fill="transparent"
            strokeWidth={stroke}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
          {/* Progress Ring */}
          <circle
            stroke="url(#gradient)"
            fill="transparent"
            strokeWidth={stroke}
            strokeDasharray={circumference + ' ' + circumference}
            style={{ strokeDashoffset, transition: 'stroke-dashoffset 0.5s ease-out' }}
            strokeLinecap="round"
            r={normalizedRadius}
            cx={radius}
            cy={radius}
            className="drop-shadow-[0_0_15px_rgba(0,255,65,0.4)]"
          />
          <defs>
            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#5442F5" /> {/* Indigo */}
              <stop offset="100%" stopColor="#00E676" /> {/* Emerald Keep */}
            </linearGradient>
          </defs>
        </svg>

        {/* Center Percentage */}
        <div className="absolute flex flex-col items-center justify-center">
          <span className="text-5xl font-black text-white tracking-tighter">
            {Math.round(progress)}<span className="text-2xl text-keep">%</span>
          </span>
          <span className="text-xs font-bold text-text-dim tracking-widest uppercase mt-1">
            {isError ? 'FAILED' : isComplete ? 'DONE' : 'PROCESSING'}
          </span>
        </div>
      </div>

      {/* Primary Status Text */}
      <h2 className="text-2xl font-bold text-white mb-4">
        {isError ? 'Processing Failed' : isComplete ? 'Processing Complete' : stepLabel || 'Analyzing Speech'}
      </h2>

      {/* Model Badge */}
      {!isError && !isComplete && (
        <div className="flex items-center gap-2 border border-keep/30 bg-keep/10 px-4 py-1.5 rounded-full mb-4">
          <RefreshCw className="w-3.5 h-3.5 text-keep animate-spin-slow" />
          <span className="text-sm font-bold text-keep uppercase tracking-wide">Silero VAD</span>
        </div>
      )}

      {/* ETA */}
      {!isError && !isComplete && (
        <p className="text-sm text-text-dim mb-10">
          {eta ? `~${eta}` : 'calculating...'}
        </p>
      )}

      {/* Error Message Box */}
      {isError && (
        <div className="w-full max-w-sm p-4 bg-cut/10 border border-cut/50 rounded-xl text-cut text-center mb-8">
          <p className="font-bold mb-1">Error Encountered</p>
          <p className="text-sm opacity-80">{errorMessage || stepLabel}</p>
        </div>
      )}

      {/* Steps Checklist */}
      <div className="w-full max-w-sm space-y-4 mb-20">
        {!isError && steps.map((step, idx) => {
          const isDone = currentStepIndex > idx || isComplete || progress >= ((idx + 1) * 33);
          const isActive = currentStepIndex === idx && !isComplete;

          return (
            <div key={idx} className={`flex items-center gap-4 transition-opacity duration-300 ${isDone || isActive ? 'opacity-100' : 'opacity-40'} relative z-10`}>
              {isDone ? (
                <CheckCircle2 className="w-6 h-6 text-keep shrink-0" />
              ) : isActive ? (
                <div className="w-6 h-6 rounded-full border-2 border-brand-indigo border-t-transparent animate-spin shrink-0" />
              ) : (
                <Circle className="w-6 h-6 text-text-dim shrink-0" />
              )}
              <span className={`text-base font-medium ${isDone ? 'text-text-dim' : isActive ? 'text-white' : 'text-text-dim'}`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer / Cancel Button */}
      <div className="w-full max-w-sm flex flex-col items-center justify-center mt-8 z-10">
        {!isComplete && !isError && (
          <p className="text-xs text-text-dim mb-4">Please keep the app open while we process your video.</p>
        )}

        {onCancel && !isComplete && !isError && (
          <button
            onClick={onCancel}
            className="w-full py-4 border border-cut/30 bg-bg-card hover:bg-cut/10 text-cut font-bold rounded-2xl flex items-center justify-center gap-2 transition"
          >
            <X className="w-5 h-5" />
            <span>Cancel Processing</span>
          </button>
        )}

        {(isComplete || isError) && onReset && (
          <button
            onClick={onReset}
            className={`w-full py-4 rounded-2xl font-bold uppercase text-sm tracking-widest transition glow-primary ${isError
              ? 'bg-cut hover:bg-red-600 text-white shadow-cut/20'
              : 'bg-brand-indigo hover:bg-brand-indigo-hover text-white'
              }`}
          >
            {isError ? 'Try Again' : 'Done'}
          </button>
        )}
      </div>
    </div>
  );
};

export default Scanner;
