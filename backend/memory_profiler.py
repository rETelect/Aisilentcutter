import tracemalloc
import functools
import logging
import gc

def profile_memory_usage(func):
    """Decorator to profile memory usage of a function."""
    @functools.wraps(func)
    async def async_wrapper(*args, **kwargs):
        was_tracing = tracemalloc.is_tracing()
        if not was_tracing:
            tracemalloc.start()
        snapshot1 = tracemalloc.take_snapshot()
        try:
            return await func(*args, **kwargs)
        finally:
            snapshot2 = tracemalloc.take_snapshot()
            top_stats = snapshot2.compare_to(snapshot1, 'lineno')
            logging.info(f"[Memory Profiler] Top 3 allocations in {func.__name__}:")
            for stat in top_stats[:3]:
                logging.info(f"  {stat}")
            if not was_tracing:
                tracemalloc.stop()
            gc.collect()

    @functools.wraps(func)
    def sync_wrapper(*args, **kwargs):
        was_tracing = tracemalloc.is_tracing()
        if not was_tracing:
            tracemalloc.start()
        snapshot1 = tracemalloc.take_snapshot()
        try:
            return func(*args, **kwargs)
        finally:
            snapshot2 = tracemalloc.take_snapshot()
            top_stats = snapshot2.compare_to(snapshot1, 'lineno')
            logging.info(f"[Memory Profiler] Top 3 allocations in {func.__name__}:")
            for stat in top_stats[:3]:
                logging.info(f"  {stat}")
            if not was_tracing:
                tracemalloc.stop()
            gc.collect()

    import asyncio
    if asyncio.iscoroutinefunction(func):
        return async_wrapper
    return sync_wrapper
