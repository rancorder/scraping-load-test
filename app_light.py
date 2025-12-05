from fastapi import FastAPI, HTTPException
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from starlette.responses import Response
import asyncio, random, time, psutil
from datetime import datetime

app = FastAPI()
SCRAPE_REQUESTS = Counter("scrape_requests_total", "Total", ["site", "type", "status"])
SCRAPE_DURATION = Histogram("scrape_duration_seconds", "Duration", ["site", "type"])
ACTIVE_SCRAPERS = Gauge("active_scrapers", "Active")
MEMORY_USAGE = Gauge("memory_usage_mb", "Memory MB")
PLAYWRIGHT_INSTANCES = Gauge("playwright_instances", "Playwright")

active_tasks = 0
playwright_tasks = 0

async def mock_playwright(site_id: str):
    global playwright_tasks
    playwright_tasks += 1
    PLAYWRIGHT_INSTANCES.set(playwright_tasks)
    try:
        await asyncio.sleep(random.uniform(5, 10))
        success = random.random() > 0.15
        return {"site_id": site_id, "type": "playwright", "success": success, "memory_mb": 175}
    finally:
        playwright_tasks -= 1
        PLAYWRIGHT_INSTANCES.set(playwright_tasks)

async def mock_normal(site_id: str):
    await asyncio.sleep(random.uniform(2, 6))
    success = random.random() > 0.08
    return {"site_id": site_id, "type": "normal", "success": success, "memory_mb": 20}

def get_memory():
    mb = psutil.Process().memory_info().rss / 1024 / 1024
    MEMORY_USAGE.set(mb)
    return mb

@app.get("/health")
async def health():
    return {"status": "ok", "memory_mb": round(get_memory(), 2), "active": active_tasks, "playwright": playwright_tasks}

@app.post("/api/scrape/{site_id}")
async def scrape(site_id: str, use_playwright: bool = False):
    global active_tasks
    active_tasks += 1
    ACTIVE_SCRAPERS.set(active_tasks)
    start = time.time()
    try:
        result = await (mock_playwright(site_id) if use_playwright else mock_normal(site_id))
        status = "success" if result["success"] else "failure"
        SCRAPE_REQUESTS.labels(site=site_id, type=result["type"], status=status).inc()
        SCRAPE_DURATION.labels(site=site_id, type=result["type"]).observe(time.time() - start)
        get_memory()
        if not result["success"]:
            raise HTTPException(500, "Failed")
        return result
    finally:
        active_tasks -= 1
        ACTIVE_SCRAPERS.set(active_tasks)

@app.get("/metrics")
async def metrics():
    get_memory()
    return Response(generate_latest(), media_type="text/plain")

@app.get("/stats")
async def stats():
    mb = get_memory()
    return {"memory_mb": round(mb, 2), "limit_mb": 4096, "percent": round(mb/4096*100, 2), "active": active_tasks, "playwright": playwright_tasks}
