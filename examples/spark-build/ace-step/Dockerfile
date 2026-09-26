FROM nvidia/cuda@sha256:6e43a6b02e5f16e4a715953be8b29c40acbe84aed11a61357ef0fc899967fbd9
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-venv python3-dev build-essential ffmpeg libsndfile1 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ace-venv
ENV PATH="/opt/ace-venv/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.lock /opt/stargate/requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes --no-deps -r /opt/stargate/requirements.lock
COPY ace-step-src/ /opt/ace-step/
COPY apply-metadata-patch.py /opt/stargate/apply-metadata-patch.py
COPY apply-recipe-fields.py verify-api-fields.py /opt/stargate/
RUN python /opt/stargate/apply-metadata-patch.py \
    && python /opt/stargate/apply-recipe-fields.py \
    && python /opt/stargate/verify-api-fields.py > /opt/stargate/recipe-fields-verification.json \
    && cat /opt/stargate/recipe-fields-verification.json \
    && python -m pip install --no-cache-dir --no-deps --no-build-isolation /opt/ace-step/acestep/third_parts/nano-vllm \
    && ln -s /models/ace-step /opt/ace-step/checkpoints \
    && ln -s /data/cache /opt/ace-step/.cache \
    && ln -s /data/gradio_outputs /opt/ace-step/gradio_outputs
WORKDIR /opt/ace-step
ENV ACESTEP_NO_INIT=false ACESTEP_CONFIG_PATH=acestep-v15-xl-sft \
    ACESTEP_INIT_LLM=true ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-4B \
    ACESTEP_API_WORKERS=1 ACESTEP_CHECKPOINTS_DIR=/models/ace-step \
    HOME=/data HF_HOME=/data/huggingface ACESTEP_TMPDIR=/data/tmp
COPY manifest.json build-receipt.json /opt/stargate/
EXPOSE 8002
CMD ["python", "-m", "acestep.api_server", "--host", "0.0.0.0", "--port", "8002", "--init-llm"]
