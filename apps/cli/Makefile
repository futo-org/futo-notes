VERSION ?= dev

.PHONY: build build-all clean test

build:
	go build -ldflags="-s -w" -o stonefruit .

build-all:
	GOOS=linux GOARCH=amd64 go build -ldflags="-s -w -X main.version=$(VERSION)" -o dist/stonefruit-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build -ldflags="-s -w -X main.version=$(VERSION)" -o dist/stonefruit-linux-arm64 .
	GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w -X main.version=$(VERSION)" -o dist/stonefruit-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w -X main.version=$(VERSION)" -o dist/stonefruit-darwin-arm64 .

test:
	go test ./...

clean:
	rm -f stonefruit
	rm -rf dist/
