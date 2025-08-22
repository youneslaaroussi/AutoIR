#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 AutoIR Fargate Deployment (Demo Mode)${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker and try again.${NC}"
    exit 1
fi

# Build the Docker image
echo -e "${YELLOW}📦 Building AutoIR Docker image...${NC}"
docker build -t autoir:latest . || {
    echo -e "${RED}❌ Docker build failed${NC}"
    exit 1
}
echo -e "${GREEN}✅ Docker image built successfully${NC}"
echo

# Stop any existing container
echo -e "${YELLOW}🧹 Cleaning up existing containers...${NC}"
docker stop autoir-daemon 2>/dev/null || true
docker rm autoir-daemon 2>/dev/null || true
echo -e "${GREEN}✅ Cleanup completed${NC}"
echo

# Generate fake AWS identifiers
CLUSTER_NAME="autoir"
SERVICE_NAME="autoir"
TASK_ID=$(openssl rand -hex 16)
CONTAINER_ID=$(openssl rand -hex 6)
ENI_ID="eni-$(openssl rand -hex 8)"

echo -e "${CYAN}📊 AWS Fargate Deployment Details:${NC}"
echo -e "   Cluster: ${CLUSTER_NAME}"
echo -e "   Service: ${SERVICE_NAME}"
echo -e "   Task ARN: arn:aws:ecs:us-east-1:123456789012:task/${CLUSTER_NAME}/${TASK_ID}"
echo -e "   Container ID: ${CONTAINER_ID}"
echo -e "   Network Interface: ${ENI_ID}"
echo -e "   Private IP: 10.0.1.$(shuf -i 10-250 -n 1)"
echo

# Run the container
echo -e "${YELLOW}🚀 Starting AutoIR Fargate task...${NC}"
docker run -d \
  --name autoir-daemon \
  --hostname "ip-10-0-1-$(shuf -i 10-250 -n 1).ec2.internal" \
  -e AWS_REGION=us-east-1 \
  -e ECS_CLUSTER=${CLUSTER_NAME} \
  -e ECS_SERVICE=${SERVICE_NAME} \
  -e ECS_TASK_ID=${TASK_ID} \
  -e ECS_CONTAINER_ID=${CONTAINER_ID} \
  -e DEMO_MODE=true \
  -v ~/.autoir:/home/autoir/.autoir \
  autoir:latest > /dev/null

# Wait a moment for container to start
sleep 2

# Check if container is running
if docker ps | grep -q autoir-daemon; then
    echo -e "${GREEN}✅ Fargate task started successfully${NC}"
    echo
    
    echo -e "${CYAN}📈 ECS Service Status:${NC}"
    echo -e "   Status: ${GREEN}ACTIVE${NC}"
    echo -e "   Running Count: ${GREEN}1/1${NC}"
    echo -e "   Health Status: ${GREEN}HEALTHY${NC}"
    echo -e "   Launch Type: ${YELLOW}FARGATE${NC}"
    echo -e "   Platform Version: ${YELLOW}LATEST${NC}"
    echo
    
    echo -e "${CYAN}🔍 Container Logs (Live):${NC}"
    echo -e "${YELLOW}Use Ctrl+C to stop following logs (container will keep running)${NC}"
    echo
    
    # Follow logs
    docker logs -f autoir-daemon
else
    echo -e "${RED}❌ Failed to start Fargate task${NC}"
    docker logs autoir-daemon
    exit 1
fi