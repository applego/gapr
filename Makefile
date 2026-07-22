# APR Makefile - Common development tasks

.PHONY: all check test lint checksums update-checksums install-hooks help

# Default target
all: check

# Run all checks
check: lint checksums test

# Run shellcheck
lint:
	@echo "Running ShellCheck..."
	@shellcheck -S warning apr install.sh
	@bash -n apr
	@bash -n install.sh
	@echo "ShellCheck passed!"

# Verify checksums are up to date
checksums:
	@echo "Verifying checksums..."
	@apr_hash=$$(sha256sum apr | awk '{print $$1}'); \
	stored_hash=$$(cat apr.sha256 2>/dev/null | awk '{print $$1}' | tr -d '[:space:]'); \
	if [ "$$apr_hash" != "$$stored_hash" ]; then \
		echo "ERROR: apr.sha256 is out of date!"; \
		echo "  Current: $$apr_hash"; \
		echo "  Stored:  $$stored_hash"; \
		echo "Run 'make update-checksums' to fix."; \
		exit 1; \
	fi
	@install_hash=$$(sha256sum install.sh | awk '{print $$1}'); \
	stored_hash=$$(cat install.sh.sha256 2>/dev/null | awk '{print $$1}' | tr -d '[:space:]'); \
	if [ "$$install_hash" != "$$stored_hash" ]; then \
		echo "ERROR: install.sh.sha256 is out of date!"; \
		echo "  Current: $$install_hash"; \
		echo "  Stored:  $$stored_hash"; \
		echo "Run 'make update-checksums' to fix."; \
		exit 1; \
	fi
	@gapr_hash=$$(sha256sum gapr | awk '{print $$1}'); \
	stored_hash=$$(cat gapr.sha256 2>/dev/null | awk '{print $$1}' | tr -d '[:space:]'); \
	if [ "$$gapr_hash" != "$$stored_hash" ]; then \
		echo "ERROR: gapr.sha256 is out of date!"; \
		echo "  Current: $$gapr_hash"; \
		echo "  Stored:  $$stored_hash"; \
		echo "Run 'make update-checksums' to fix."; \
		exit 1; \
	fi
	@helper_hash=$$(sha256sum gemini-helper.sh | awk '{print $$1}'); \
	stored_hash=$$(cat gemini-helper.sh.sha256 2>/dev/null | awk '{print $$1}' | tr -d '[:space:]'); \
	if [ "$$helper_hash" != "$$stored_hash" ]; then \
		echo "ERROR: gemini-helper.sh.sha256 is out of date!"; \
		echo "  Current: $$helper_hash"; \
		echo "  Stored:  $$stored_hash"; \
		echo "Run 'make update-checksums' to fix."; \
		exit 1; \
	fi
	@echo "Checksums OK!"

# Update all checksum files
update-checksums:
	@echo "Updating checksums..."
	@sha256sum apr | awk '{print $$1}' > apr.sha256
	@sha256sum install.sh | awk '{print $$1}' > install.sh.sha256
	@sha256sum gapr | awk '{print $$1}' > gapr.sha256
	@sha256sum gemini-helper.sh | awk '{print $$1}' > gemini-helper.sh.sha256
	@sha256sum apr install.sh gapr gemini-helper.sh > checksums.txt
	@sha256sum apr install.sh gapr gemini-helper.sh > CHECKSUMS.sha256
	@echo "Updated checksums:"
	@echo "  apr:        $$(cat apr.sha256)"
	@echo "  install.sh: $$(cat install.sh.sha256)"

# Run tests
test:
	@echo "Running tests..."
	@./tests/run_tests.sh

# Install git hooks
install-hooks:
	@echo "Installing git hooks..."
	@mkdir -p .git/hooks
	@ln -sf ../../scripts/pre-commit-checksum .git/hooks/pre-commit
	@echo "Pre-commit hook installed!"

# Show help
help:
	@echo "APR Development Makefile"
	@echo ""
	@echo "Targets:"
	@echo "  make check            - Run all checks (lint, checksums, test)"
	@echo "  make lint             - Run ShellCheck and syntax validation"
	@echo "  make checksums        - Verify checksums are up to date"
	@echo "  make update-checksums - Update all checksum files"
	@echo "  make test             - Run the test suite"
	@echo "  make install-hooks    - Install git pre-commit hook"
	@echo "  make help             - Show this help"
