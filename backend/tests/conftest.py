import pytest
import os
import shutil
from pathlib import Path

# Fixture to provide a temporary directory for processing
@pytest.fixture(scope="session")
def test_dir(tmp_path_factory):
    base_dir = tmp_path_factory.mktemp("video_tests")
    yield base_dir
    # Cleanup after session
    shutil.rmtree(base_dir, ignore_errors=True)
