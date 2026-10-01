.PHONY: build test typecheck install install-v1 install-v2 uninstall

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

install:
	./install.sh

install-v1:
	./install.sh --v1

install-v2:
	./install.sh --v2

uninstall:
	./install.sh --uninstall
