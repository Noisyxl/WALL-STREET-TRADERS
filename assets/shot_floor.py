"""Screenshot the floorview while a session is running.

    python assets/shot_floor.py [port] [out.png]

Starts nothing by itself: run `outcry floor --minutes 90` in another terminal
first, then this. It waits for the page to have received at least one state
message, so the screenshot is never of an empty board.

Requires: pip install playwright && playwright install chromium
"""
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1792
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / "floorview.png"
FULL = len(sys.argv) > 3 and sys.argv[3] == "full"


async def main() -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1680, "height": 1080}, device_scale_factor=2)
        # `networkidle` never fires: the page holds an open event stream by design.
        await page.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded")
        # Wait for a real session, not the empty shell.
        await page.wait_for_function("document.querySelector('#session').textContent !== '—'", timeout=30_000)
        await page.wait_for_timeout(1200)
        # Viewport, not full page: the README wants what a person sees when the
        # page opens, and a full-page shot of a busy session is 4 000 px tall.
        await page.screenshot(path=str(OUT), full_page=FULL)
        await browser.close()
    print("rendered", OUT)


asyncio.run(main())
