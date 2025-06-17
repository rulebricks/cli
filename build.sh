#!/bin/bash
# Builds CLI and updates the rulebricks binary

go build -o rulebricks ./src && \
 sudo cp rulebricks /usr/local/bin/rulebricks && \
    echo "Rulebricks binary updated successfully."
