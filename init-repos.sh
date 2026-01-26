#!/bin/bash
# init-repos.sh
# Initialize multiple GitHub repositories

set -e

# Check if GITHUB_REPOS is set
if [ -z "$GITHUB_REPOS" ]; then
    echo "ERROR: GITHUB_REPOS environment variable is not set"
    exit 1
fi

# Check if GITHUB_USER and GITHUB_TOKEN are set
if [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_TOKEN" ]; then
    echo "ERROR: GITHUB_USER and GITHUB_TOKEN must be set"
    exit 1
fi

# Split repositories by comma and process each one
IFS=',' read -ra REPOS <<< "$GITHUB_REPOS"

echo "Found ${#REPOS[@]} repository/repositories to process"

for repo in "${REPOS[@]}"; do
    # Trim whitespace
    repo=$(echo "$repo" | xargs)
    
    if [ -z "$repo" ]; then
        continue
    fi
    
    echo "----------------------------------------"
    echo "Processing repository: $repo"
    
    REPO_DIR="/workspace/$repo"
    
    # Configure Git to trust the directory (must be done BEFORE any git operations)
    echo "Configuring Git to trust directory: $REPO_DIR"
    git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true
    
    # Check if repository directory already exists
    if [ -d "$REPO_DIR/.git" ]; then
        echo "Repository $repo already exists, pulling latest changes..."
        cd "$REPO_DIR"
        git pull origin main || git pull origin master || echo "WARNING: Could not pull latest changes"
    else
        echo "Cloning repository $repo..."
        
        # Remove directory if it exists but is not a git repo
        if [ -d "$REPO_DIR" ]; then
            echo "WARNING: Directory exists but is not a git repository, removing..."
            rm -rf "$REPO_DIR"
        fi
        
        # Clone the repository
        git clone "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${repo}.git" "$REPO_DIR"
        
        if [ $? -eq 0 ]; then
            echo "Successfully cloned $repo"
        else
            echo "ERROR: Failed to clone $repo"
            continue
        fi
    fi
    
    # Set proper ownership
    if [ -n "$PUID" ] && [ -n "$PGID" ]; then
        chown -R "$PUID:$PGID" "$REPO_DIR"
    fi
    
    echo "Repository $repo ready"
done

echo "----------------------------------------"
echo "All repositories initialized successfully"
echo "Workspace directory structure:"
ls -la /workspace/

exit 0
