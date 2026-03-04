import logging
from logging.handlers import RotatingFileHandler
import os
import platform
from pathlib import Path
try:
    import platformdirs
    LOG_DIR = Path(platformdirs.user_data_dir("SilentCutter"))
except ImportError:
    LOG_DIR = Path.home() / ".silentcutter"

LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / ".silentcutter_crash.log"

def setup_crash_logger(name="SilentCutter"):
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
        
    logger.setLevel(logging.DEBUG)
    
    # Rotating file handler: 5MB per file, max 3 backups
    handler = RotatingFileHandler(LOG_FILE, maxBytes=5*1024*1024, backupCount=3)
    formatter = logging.Formatter('%(asctime)s - [%(levelname)s] - %(name)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    
    return logger

def log_hardware_diagnostics(logger):
    try:
        import psutil
        import torch
        logger.info(f"OS: {platform.system()} {platform.release()}")
        logger.info(f"Architecture: {platform.machine()}")
        logger.info(f"RAM Total: {psutil.virtual_memory().total / (1024**3):.2f} GB")
        logger.info(f"CPU Cores: {psutil.cpu_count(logical=True)}")
        
        gpu_info = "None/CPU"
        if torch.cuda.is_available():
            gpu_info = f"CUDA (Device Name: {torch.cuda.get_device_name(0)})"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            gpu_info = "Apple Metal Performance Shaders (MPS)"
            
        logger.info(f"GPU Acceleration: {gpu_info}")
    except Exception as e:
        logger.error(f"Failed to fetch hardware diagnostics: {e}")

# Create global logger instance
crash_logger = setup_crash_logger()
log_hardware_diagnostics(crash_logger)
