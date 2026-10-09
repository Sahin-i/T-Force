FROM node:22-bookworm-slim

COPY requirements.txt /opt/office-requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ripgrep python3 python3-venv ca-certificates fonts-dejavu-core \
 && python3 -m venv /opt/office-python \
 && /opt/office-python/bin/pip install --no-cache-dir -r /opt/office-requirements.txt \
 && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/office-python/bin:${PATH}" PYTHONDONTWRITEBYTECODE=1 HOME=/tmp
COPY tool-helper.py /opt/office-agent/tool-helper.py
RUN chmod 0555 /opt/office-agent/tool-helper.py && mkdir -p /workspace && chmod 0777 /workspace
WORKDIR /workspace
USER 1000:1000
CMD ["sleep", "infinity"]
