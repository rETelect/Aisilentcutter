import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    logPath: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
        logPath: null
    };

    public static getDerivedStateFromError(error: any): State {
        let logPath = null;
        if (error.logPath) {
            logPath = error.logPath;
        } else if (error.message && error.message.includes("LOG_PATH:")) {
            logPath = error.message.split("LOG_PATH:")[1].trim();
        }
        return { hasError: true, error, logPath };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="fixed inset-0 z-[100] bg-red-950/90 backdrop-blur-md flex items-center justify-center p-6 text-white font-sans">
                    <div className="max-w-2xl w-full bg-bg-dark border border-red-500/50 rounded-2xl p-8 shadow-2xl flex flex-col items-center text-center">
                        <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mb-6">
                            <AlertOctagon className="w-10 h-10 text-red-500" />
                        </div>
                        <h1 className="text-2xl font-bold mb-4">Fatal System Crash</h1>
                        <p className="text-text-dim mb-6 text-lg">
                            The application encountered an unrecoverable error and was forced to halt to prevent data corruption.
                        </p>

                        {this.state.logPath ? (
                            <div className="w-full bg-black/50 border border-red-500/30 p-4 rounded-xl text-left mb-8 break-all">
                                <p className="text-sm font-bold text-red-400 mb-2 uppercase tracking-wide">Diagnostic Crash Log Path</p>
                                <code className="text-sm font-mono text-white select-all">
                                    {this.state.logPath}
                                </code>
                            </div>
                        ) : (
                            <div className="w-full bg-black/50 border border-red-500/30 p-4 rounded-xl text-left mb-8">
                                <p className="text-sm text-red-400 font-mono">{this.state.error?.message || "Unknown fatal error"}</p>
                            </div>
                        )}

                        <p className="text-sm text-text-dim mb-8">
                            Please email the log file above to <span className="text-white font-bold">support@silentcutter.test</span> for immediate diagnostic review.
                        </p>

                        <button
                            onClick={() => window.location.reload()}
                            className="px-8 py-3 bg-red-600 hover:bg-red-500 transition rounded-full font-bold uppercase tracking-wider text-sm shadow-xl shadow-red-900/50"
                        >
                            Restart Application
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
