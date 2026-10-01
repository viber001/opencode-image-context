.PHONY: build test typecheck install install-v1 install-v2 uninstall

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

install:
	./install.sh

# One dual-compatible file serves both hosts, so these are aliases.
install-v1 install-v2: install

uninstall:
	./install.sh --uninstall
