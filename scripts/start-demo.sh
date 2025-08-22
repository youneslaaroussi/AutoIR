#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 AutoIR Demo Environment${NC}"
echo -e "${CYAN}═══════════════════════════════${NC}"
echo

# Set demo environment variables
export DEMO_MODE=true
export AWS_REGION=us-east-1
export SAGEMAKER_ENDPOINT=demo-endpoint
export LOG_GROUPS="/aws/lambda/user-api,/aws/lambda/payment-service,/aws/ecs/web-frontend"

echo -e "${YELLOW}Setting up demo environment...${NC}"
echo "  • DEMO_MODE=true (forces mock services)"
echo "  • AWS_REGION=us-east-1"  
echo "  • SAGEMAKER_ENDPOINT=demo-endpoint"
echo "  • LOG_GROUPS=realistic AWS services"
echo

# Build if needed
if [ ! -d "dist" ]; then
    echo -e "${YELLOW}Building project...${NC}"
    npm run build
    echo
fi

# Make sure binary is executable
chmod +x bin/run.js

echo -e "${GREEN}✅ Demo environment ready!${NC}"
echo
echo -e "${CYAN}Now you can run any existing commands and they'll use realistic mock data:${NC}"
echo
echo "  ${YELLOW}# Semantic log search${NC}"
echo "  ./bin/run.js logs query \"database error\" --sagemaker-endpoint demo-endpoint"
echo
echo "  ${YELLOW}# Start log ingestion daemon${NC}" 
echo "  ./bin/run.js daemon --alertsEnabled"
echo
echo "  ${YELLOW}# Deploy to 'Fargate' (runs locally but looks real)${NC}"
echo "  ./bin/run.js aws autoir-fargate deploy --localRun"
echo
echo "  ${YELLOW}# Main AutoIR interface${NC}"
echo "  ./bin/run.js"
echo
echo -e "${CYAN}All commands work exactly as before, but with impressive mock data!${NC}"
echo -e "${GREEN}No --demo flags needed - everything just works.${NC}"