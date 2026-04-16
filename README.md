# Video Jump-Cutter

A powerful, local-first application that automatically detects and removes silence from your videos. Built with a robust Python backend for media processing and a sleek Electron/React frontend for a seamless user experience.

## Features

- **Automated Silence Detection**: Uses `Silero VAD` (Voice Activity Detection) to accurately identify speech and silence segments.
- **Smart Cutting**: Automatically skips silent parts to create a fast-paced, engaging video.
- **Advanced Manual Editor**: Fine-tune your project with an interactive visual timeline denoting speech (green) and explicitly cut gaps (red). Includes support for sub-file editing within merged projects.
- **Multi-File "Merge" Mode**: Seamlessly concatenate and process multiple source files together with frame-accurate extraction and zero A/V desync.
- **Hardware Acceleration**: Automatic utilization of NVIDIA (NVENC) and AMD (VAAPI/AMF) GPU encoders for rapid rendering, falling back to CPU efficiently.
- **Real-Time ETA**: Displays accurate render time estimations dynamically during segment extraction and processing.
- **Extensively Tested**: Hardened FFmpeg orchestration backend validated by an exhaustive automated E2E testing matrix.
- **Local Processing**: All video processing happens locally on your machine—no data leaves your computer.
- **Large File Support**: Optimized to handle heavy files efficiently.
- **Cross-Platform**: Designed to run cleanly on desktop environments (Linux heavily tested).

## Technology Stack

- **Backend**: Python, FastAPI, PyTorch, FFmpeg, Silero VAD
- **Frontend**: React, TypeScript, Vite, TailwindCSS
- **Desktop Wrapper**: Electron

## Prerequisites

- **Python 3.12+**
- **Node.js 20+** (and `npm`)
- **FFmpeg** (Must be installed and accessible in your system PATH)
- **SSH Key Configured**: Ensure you have an SSH key generated and linked to your GitHub account for secure authentication.

## Installation

### 1. Clone the Repository (via SSH)

 Use the SSH protocol to securely clone the repository:

```bash
git clone git@github.com:yourusername/silentcutter.git
cd silentcutter
```

### 2. Setup Dependencies

Initialize both the Python backend and the Node.js frontend environments:

```bash
# Setup Backend
python3 -m venv backend/venv
source backend/venv/bin/activate
pip install -r backend/requirements.txt

# Setup Frontend
cd frontend
npm install
cd ..
```

## Running the Application

You can start both the backend API and the Electron interface automatically using the provided bash script:

```bash
# Make sure the script is executable
chmod +x start_electron.sh

# Run the app
./start_electron.sh
```

## Usage

1. **Launch the App**: Run the script above to open the application.
2. **Select Video**: Drag and drop a video file or browse to select one.
3. **Analyze**: The app will process the audio to detect silence.
4. **Review**: See the generated timeline with cut/keep segments.
5. **Render**: Click to render the final video with silence removed.
6. **Output**: The processed video will be saved in the `backend/outputs` directory.

## License

[MIT License](LICENSE)
