# Gemini Web-Bridge — CI/CD Makefile
# Usage: make dev | make test | make deploy | make health

SHELL := /bin/bash
WORKER_DIR := cloudflare-worker
WORKER_NAME := gemini-web-bridge
WORKER_URL := https://gemini-web-bridge.pphothidaen.workers.dev
NODE_VERSION := 20

.PHONY: help install dev test test-watch lint deploy deploy-staging health health-deep secrets-check clean

## help: Show this help message
help:
	@echo "Gemini Web-Bridge — Available targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'

## install: Install worker dependencies
install:
	cd $(WORKER_DIR) && npm install

## dev: Start local Wrangler dev server
dev:
	cd $(WORKER_DIR) && npx wrangler dev

## test: Run unit tests
test:
	cd $(WORKER_DIR) && npm test

## test-watch: Run tests in watch mode
test-watch:
	cd $(WORKER_DIR) && npm run test:watch

## test-integration: Run integration tests against live worker
test-integration:
	cd $(WORKER_DIR) && node --test tests/integration.test.mjs

## lint: Syntax check worker source
lint:
	cd $(WORKER_DIR) && npm run lint

## deploy: Deploy to production (Cloudflare Workers)
deploy:
	cd $(WORKER_DIR) && npx wrangler deploy \
		--name $(WORKER_NAME) \
		--compatibility-date 2026-09-12 \
		--compatibility-flag nodejs_compat

## deploy-staging: Deploy to staging environment
deploy-staging:
	cd $(WORKER_DIR) && npx wrangler deploy \
		--name $(WORKER_NAME)-staging \
		--compatibility-date 2026-09-12 \
		--compatibility-flag nodejs_compat

## health: Quick health check against production
health:
	@echo "=== Health Check: $(WORKER_URL) ==="
	@curl -s $(WORKER_URL)/health | jq .
	@echo ""
	@echo "=== Auth Check ==="
	@curl -s -H "Authorization: Bearer $(CF_TOKEN)" $(WORKER_URL)/bridge/auth-check | jq .

## health-deep: Deep health check with diagnostics
health-deep:
	@echo "=== Deep Health Check ==="
	@bash scripts/health-check.sh

## secrets-check: Verify required secrets are configured
secrets-check:
	@echo "=== Checking Wrangler Secrets ==="
	@if [ -z "$(CLOUDFLARE_API_TOKEN)" ]; then \
		echo "❌ CLOUDFLARE_API_TOKEN not set"; \
	else \
		echo "✅ CLOUDFLARE_API_TOKEN is set"; \
	fi
	@if [ -z "$(CLOUDFLARE_ACCOUNT_ID)" ]; then \
		echo "❌ CLOUDFLARE_ACCOUNT_ID not set"; \
	else \
		echo "✅ CLOUDFLARE_ACCOUNT_ID is set"; \
	fi
	@cd $(WORKER_DIR) && npx wrangler secret list 2>/dev/null || echo "⚠️  Could not list secrets (not authenticated?)"

## clean: Remove node_modules and build artifacts
clean:
	rm -rf $(WORKER_DIR)/node_modules $(WORKER_DIR)/.wrangler
