# Retire dead spark1/spark2/m3-studio/qwen config entries
spark1/spark2 (Qwen vLLM) and m3-studio (oMLX Qwen) are drained; Qwen was replaced by
GLM. The M3 Ultra now runs GLM oQ8e exclusively (8013). Remove or archive these nodes
after confirming nothing references them (Hermes profiles, Pi models.json point at
PoolModel only). Keep the serving_profiles entries only if recipes may return.
