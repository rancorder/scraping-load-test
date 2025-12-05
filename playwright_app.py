from fastapi import FastAPI, HTTPException
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from starlette.responses import Response
import asyncio
import random
import time
import psutil
from datetime import datetime

app = FastAPI(title="Playwright Load Test")

SCRAPE_REQUESTS = Counter("scrape_requests_total", "Total scrape requests", ["site", "type", "status"])
SCRAPE_DURATION = Histogram("scrape_duration_seconds", "Scrape duration", ["site", "type"])
ACTIVE_SCRAPERS = Gauge("active_scrapers", "Number of active scrapers")
MEMORY_USAGE = Gauge("memory_usage_mb", "Memory usage in MB")
PLAYWRIGHT_INSTANCES = Gauge("playwright_instances", "Number of Playwright instances")

active_tasks = 0
playwright_tasks = 0
memory_blocks = []

class PlaywrightSimulator:
    @staticmethod
    def estimate_memory_usage():
        return random.randint(150, 200)
    
    @staticmethod
    async def simulate_playwright_scrape(site_id: str):
        global playwright_tasks, memory_blocks
        memory_size = PlaywrightSimulator.estimate_memory_usage()
        memory_block = bytearray(memory_size * 1024 * 1024)
        memory_blocks.append(memory_block)
        playwright_tasks += 1
        PLAYWRIGHT_INSTANCES.set(playwright_tasks)
        try:
            duration = random.uniform(5, 15)
            await asyncio.sleep(duration)
            success = random.random() > 0.15
            return {"site_id": site_id, "type": "playwright", "duration": duration, "success": success, "memory_used_mb": memory_size, "items_found": random.randint(10, 100) if success else 0}
        finally:
            playwright_tasks -= 1
            PLAYWRIGHT_INSTANCES.set(playwright_tasks)
            memory_blocks.remove(memory_block)
            del memory_block

class NormalScraperSimulator:
    @staticmethod
    async def simulate_normal_scrape(site_id: str):
        duration = random.uniform(2, 8)
        await asyncio.sleep(duration)
        success = random.random() > 0.08
        return {"site_id": site_id, "type": "normal", "duration": duration, "success": success, "memory_used_mb": random.randint(10, 30), "items_found": random.randint(5, 50) if success else 0}

def update_memory_metrics():
    process = psutil.Process()
    memory_mb = process.memory_info().rss / 1024 / 1024
    MEMORY_USAGE.set(memory_mb)
    return memory_mb

@app.get("/health")
async def health():
    memory_mb = update_memory_metrics()
    return {"status": "healthy", "active_scrapers": active_tasks, "playwright_instances": playwright_tasks, "memory_usage_mb": round(memory_mb, 2), "timestamp": datetime.utcnow().isoformat()}

@app.post("/api/scrape/{site_id}")
async def trigger_scrape(site_id: str, use_playwright: bool = False):
    global active_tasks
    active_tasks += 1
    ACTIVE_SCRAPERS.set(active_tasks)
    start_time = time.time()
    try:
        if use_playwright:
            result = await PlaywrightSimulator.simulate_playwright_scrape(site_id)
        else:
            result = await NormalScraperSimulator.simulate_normal_scrape(site_id)
        status = "success" if result["success"] else "failure"
        scrape_type = result["type"]
        SCRAPE_REQUESTS.labels(site=site_id, type=scrape_type, status=status).inc()
        duration = time.time() - start_time
        SCRAPE_DURATION.labels(site=site_id, type=scrape_type).observe(duration)
        update_memory_metrics()
        if not result["success"]:
            raise HTTPException(status_code=500, detail="Scrape failed")
        return result
    except HTTPException:
        raise
    except Exception as e:
        SCRAPE_REQUESTS.labels(site=site_id, type="unknown", status="error").inc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        active_tasks -= 1
        ACTIVE_SCRAPERS.set(active_tasks)

@app.get("/metrics")
async def metrics():
    update_memory_metrics()
    return Response(content=generate_latest(), media_type="text/plain")

@app.get("/stats")
async def stats():
    memory_mb = update_memory_metrics()
    return {"active_scrapers": active_tasks, "playwright_instances": playwright_tasks, "memory_usage_mb": round(memory_mb, 2), "memory_limit_mb": 4096, "memory_usage_percent": round((memory_mb / 4096) * 100, 2), "timestamp": datetime.utcnow().isoformat()}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
