import pytest
import os
import json
import asyncio
from httpx import AsyncClient, ASGITransport
from pathlib import Path
from main import app, pending_uploads, local_file_paths, active_processors

import pytest_asyncio

@pytest_asyncio.fixture()
async def async_client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

@pytest.fixture(autouse=True)
def clean_state():
    """Ensure global state matches clean boundaries before every test."""
    pending_uploads.clear()
    local_file_paths.clear()
    active_processors.clear()
    yield

@pytest.mark.asyncio
async def test_root_endpoint(async_client: AsyncClient):
    response = await async_client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

@pytest.mark.asyncio
async def test_upload_init(async_client: AsyncClient):
    payload = {"filename": "test-video.mp4", "fileSize": 1024 * 1024}
    response = await async_client.post("/upload/init", json=payload)
    
    assert response.status_code == 200
    data = response.json()
    assert "file_id" in data
    assert data["status"] == "initialized"
    assert data["filename"] == "test-video.mp4"
    
    file_id = data["file_id"]
    assert file_id in pending_uploads
    assert pending_uploads[file_id]["file_size"] == 1024 * 1024

@pytest.mark.asyncio
async def test_upload_chunk_and_complete(async_client: AsyncClient):
    # Initialize Upload
    init_res = await async_client.post("/upload/init", json={"filename": "chunked.mp4", "fileSize": 100})
    file_id = init_res.json()["file_id"]
    
    # Send custom bytes Chunk
    chunk_data = b"0" * 50
    chunk_res = await async_client.post(
        f"/upload/chunk/{file_id}", 
        content=chunk_data,
        headers={"Content-Type": "application/octet-stream"}
    )
    
    assert chunk_res.status_code == 200
    assert chunk_res.json()["bytes_received"] == 50
    
    # Send Second Chunk
    chunk_res2 = await async_client.post(
        f"/upload/chunk/{file_id}", 
        content=chunk_data,
        headers={"Content-Type": "application/octet-stream"}
    )
    assert chunk_res2.status_code == 200
    assert chunk_res2.json()["bytes_received"] == 100
    
    # Complete
    comp_res = await async_client.post(f"/upload/complete/{file_id}")
    assert comp_res.status_code == 200
    assert comp_res.json()["status"] == "uploaded"
    assert comp_res.json()["total_bytes"] == 100
    
    # Ensure it was popped from pending_uploads
    assert file_id not in pending_uploads

@pytest.mark.asyncio
async def test_export_edl_active_session(async_client: AsyncClient):
    file_id = "mock_file_id"
    segments = [
        {"start": 0.0, "end": 2.0, "type": "keep"},
        {"start": 2.0, "end": 4.0, "type": "cut"},
        {"start": 4.0, "end": 6.0, "type": "keep"}
    ]
    
    payload = {
        "file_id": file_id,
        "segments": segments,
        "settings": {}
    }
    
    response = await async_client.post("/export_edl", json=payload)
    
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert f'filename="project_{file_id}.edl"' in response.headers["content-disposition"]
    
    edl_content = response.text
    assert "TITLE: JUMP CUTTER PROJECT" in edl_content
    assert "AX       V     C" in edl_content
    # There are two 'keep' segments, so there should be two AX lines
    assert edl_content.count("AX") == 2

@pytest.mark.asyncio
async def test_export_fcpxml_active_session(async_client: AsyncClient):
    file_id = "mock_file_id"
    segments = [
        {"start": 0.0, "end": 5.0, "type": "keep"}
    ]
    
    payload = {
        "file_id": file_id,
        "segments": segments,
        "settings": {}
    }
    
    response = await async_client.post("/export_fcpxml", json=payload)
    
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    assert f'filename="project_{file_id}.fcpxml"' in response.headers["content-disposition"]
    
    xml_content = response.text
    assert "<fcpxml version=" in xml_content
    assert "<format id=" in xml_content
    assert '<asset-clip name=' in xml_content

@pytest.mark.asyncio
async def test_status_polling_not_found(async_client: AsyncClient):
    response = await async_client.get("/status/invalid_id")
    assert response.status_code == 404
