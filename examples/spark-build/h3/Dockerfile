FROM nvcr.io/nvidia/pytorch@sha256:4a85d8cf6fb3a943280960b8948cf4e9b6eca77b4414c68c9b2c7bb863f79b70
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 HF_XET_HIGH_PERFORMANCE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    git git-lfs curl ca-certificates ffmpeg libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    tini procps jq && rm -rf /var/lib/apt/lists/* && git lfs install --system
COPY constraints.txt /opt/stargate/constraints.txt
COPY comfyui-src/ /opt/ComfyUI/
WORKDIR /opt/ComfyUI
RUN grep -Ev '^(torch|torchvision|torchaudio)([<=>~! ].*)?$' requirements.txt > /tmp/comfy-requirements.txt \
    && python -m pip install -c /opt/stargate/constraints.txt --upgrade pip setuptools wheel \
    && python -m pip install -c /opt/stargate/constraints.txt -r /tmp/comfy-requirements.txt \
    && python -m pip install -c /opt/stargate/constraints.txt 'huggingface_hub[hf_xet]>=0.34.0'
COPY torchaudio-src/ /opt/torchaudio-src/
# Match the source-built audio extension in the working NGC runtime. The job
# count limits image-build CPU work only; it does not cap model serving.
ARG BUILD_JOBS=2
RUN cd /opt/torchaudio-src && \
    BUILD_VERSION=2.8.0a0 CMAKE_BUILD_PARALLEL_LEVEL=${BUILD_JOBS} \
    TORCH_CUDA_ARCH_LIST='8.0 8.6 9.0 10.0 11.0 12.0+PTX' \
    python -m pip install --no-deps --no-build-isolation .
COPY h3-recipe-src/docker/entrypoint.sh /usr/local/bin/h3-entrypoint
COPY h3-recipe-src/LICENSE /opt/stargate/H3-RECIPE-LICENSE
RUN chmod +x /usr/local/bin/h3-entrypoint
COPY manifest.json build-receipt.json /opt/stargate/
EXPOSE 8188
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/h3-entrypoint"]
