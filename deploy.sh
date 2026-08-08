docker buildx build --platform linux/arm64 --load -t verekia/hyperpointer .
docker save verekia/hyperpointer | gzip > /tmp/hyperpointer.tar.gz
scp /tmp/hyperpointer.tar.gz midgar:/tmp/
ssh midgar docker load --input /tmp/hyperpointer.tar.gz
ssh midgar docker compose up -d hyperpointer
