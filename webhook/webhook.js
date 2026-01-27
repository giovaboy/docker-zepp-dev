const express = require("express");
const crypto = require("crypto");
const { spawn } = require("child_process");
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const bodyParser = require("body-parser");
const simpleGit = require("simple-git");
const process = require("process");
const path = require("path");
const fs = require("fs");

const SECRET = process.env.WEBHOOK_SECRET;
const USER = process.env.GITHUB_USER;
const TOKEN = process.env.GITHUB_TOKEN;
const PORT = 49000;

// Parse multiple repositories from environment variable
const REPOS = process.env.GITHUB_REPOS 
  ? process.env.GITHUB_REPOS.split(',').map(r => r.trim()).filter(Boolean)
  : [];

const LINE_HEIGHT_DEFAULT = 1.2;
const FONT_SIZE_DEFAULT = 16;
const LETTER_SPACING_DEFAULT = 0;

const WORKSPACE_DIR = "/workspace";

// Load available devices from Zeus config file
let availableDevices = [];
try {
  // Try reading from Zeus devices file (most reliable source)
  const zeusDevicesPath = '/root/.zepp/.zeus_devices';
  if (fs.existsSync(zeusDevicesPath)) {
    const zeusData = JSON.parse(fs.readFileSync(zeusDevicesPath, 'utf8'));
    // Extract device names from Zeus metadata
    availableDevices = zeusData.devices
      .filter(d => d.productName) // Only devices with product name
      .map(d => d.productName)
      .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
      .sort(); // Sort alphabetically
    
    console.log(`✅ Loaded ${availableDevices.length} devices from Zeus config`);
  } else {
    throw new Error('.zeus_devices file not found');
  }
} catch (err) {
  console.warn('⚠️  Could not load .zeus_devices, using minimal fallback:', err.message);
  // Minimal fallback list (only most common devices)
  availableDevices = [
    "Amazfit Balance",
    "Amazfit GTR 4",
    "Amazfit T-Rex 2",
    "Mi Band 7"
  ];
}

// Store active Zeus processes for each session
const activeProcesses = new Map();

const app = express();

// Regex to remove ANSI color codes
const ansiRegex = ({onlyFirst = false} = {}) => {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
  ].join('|');
  return new RegExp(pattern, onlyFirst ? undefined : 'g');
};

// Use JSON body parser for most routes
app.use(express.json());

function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const digest = "sha256=" +
    crypto.createHmac("sha256", SECRET)
          .update(req.body)
          .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Utility function to get repository path
function getRepoPath(repoName) {
  return path.join(WORKSPACE_DIR, repoName);
}

// Utility function to update a specific repository
async function updateRepository(repoName, branch = "main") {
  const repoPath = getRepoPath(repoName);
  const repoUrl = `https://${TOKEN}:x-oauth-basic@github.com/${USER}/${repoName}.git`;
  const git = simpleGit(repoPath);

  try {
    console.log(`[${repoName}] 🔧 Starting update...`);

    // 1. Update the remote 'origin' URL with token
    try {
      await git.removeRemote("origin");
    } catch (e) { /* ignore if doesn't exist */ }
    await git.addRemote("origin", repoUrl);

    // 2. Fetch everything from remote
    console.log(`[${repoName}] ⬇️  Executing git fetch...`);
    await git.fetch("origin");

    // 3. Hard reset to origin/branch
    console.log(`[${repoName}] 🔨 Executing git reset --hard origin/${branch}...`);
    const result = await git.reset(["--hard", `origin/${branch}`]);

    // 4. Install/update dependencies if package.json exists
    const packageJsonPath = path.join(repoPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      console.log(`[${repoName}] 📦 Installing or updating dependencies...`);
      const { stdout, stderr } = await exec("npm ci", { cwd: repoPath });

      if (stdout) console.log(`[${repoName}] [npm ci stdout]:\n${stdout}`);
      if (stderr) console.error(`[${repoName}] [npm ci stderr]:\n${stderr}`);
    } else {
      console.log(`[${repoName}] ℹ️  No package.json found, skipping npm install`);
    }

    console.log(`[${repoName}] ✅ Update completed! Commit:`, result.commit);
    return { success: true, commit: result.commit };

  } catch (err) {
    console.error(`[${repoName}] ❌ UPDATE ERROR:`, err);
    return { success: false, error: err.message };
  }
}

// Auto clone repositories at startup if missing
async function ensureRepo() {
  console.log("⚙️  Checking repositories configuration...");
  
  // Configure Git to trust all workspace directories globally
  console.log("⚙️  Configuring Git to trust workspace directories...");
  try {
    await exec('git config --global --add safe.directory "*"');
    console.log("✅ Git security configuration completed globally");
  } catch (e) {
    console.warn("⚠️  Could not configure global Git security (might be already configured)");
  }
  
  if (REPOS.length === 0) {
    console.warn("⚠️  No repositories configured in GITHUB_REPOS");
    return;
  }

  console.log(`📂 Configured repositories: ${REPOS.join(', ')}`);

  for (const repoName of REPOS) {
    const repoPath = getRepoPath(repoName);
    const repoUrl = `https://${TOKEN}:x-oauth-basic@github.com/${USER}/${repoName}.git`;

    // Configure Git to trust this specific directory
    try {
      await exec(`git config --global --add safe.directory ${repoPath}`);
      console.log(`[${repoName}] ✅ Git configured to trust directory`);
    } catch (e) {
      console.log(`[${repoName}] ℹ️  Git trust configuration skipped (might be already set)`);
    }

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      console.log(`[${repoName}] Repository not found, cloning...`);
      try {
        await simpleGit().clone(repoUrl, repoPath);
        console.log(`[${repoName}] ✅ Clone completed`);
      } catch (err) {
        console.error(`[${repoName}] ❌ Clone failed:`, err);
      }
    } else {
      console.log(`[${repoName}] ✓ Repository already exists`);
    }
  }
}

// Initial update for all repositories
async function runInitialUpdate() {
  console.log("🔧 Starting initial update for all repositories...");
  
  if (REPOS.length === 0) {
    console.warn("⚠️  No repositories to update");
    return false;
  }

  let allSuccess = true;

  for (const repoName of REPOS) {
    const result = await updateRepository(repoName);
    if (!result.success) {
      allSuccess = false;
    }
  }

  if (allSuccess) {
    console.log("✅ All repositories updated successfully");
  } else {
    console.warn("⚠️  Some repositories failed to update");
  }

  return allSuccess;
}

// --- ABORT ENDPOINT ---
app.post("/abort", (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'No session ID provided' });
  }
  
  const session = activeProcesses.get(sessionId);
  
  if (!session) {
    return res.json({ success: true, message: 'No active process found' });
  }
  
  try {
    // Handle both preview (direct process) and build (status object with process)
    let processToKill;
    
    if (session.process) {
      // Build session - has status object with process property
      processToKill = session.process;
      session.status = 'aborted';
      session.error = 'Build aborted by user';
    } else {
      // Preview session - is the process directly
      processToKill = session;
    }
    
    // Kill the Zeus process
    if (processToKill && !processToKill.killed) {
      processToKill.kill('SIGTERM');
    }
    
    // Remove from active processes
    activeProcesses.delete(sessionId);
    
    console.log(`🛑 Aborted process for session: ${sessionId}`);
    
    res.json({ success: true, message: 'Process aborted successfully' });
  } catch (err) {
    console.error(`Error aborting process for session ${sessionId}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- BUILD ZAB ENDPOINT ---
app.post("/build", async (req, res) => {
  const { repo } = req.body;
  
  if (!repo || !REPOS.includes(repo)) {
    return res.status(400).json({ success: false, error: `Invalid repository: ${repo}. Available: ${REPOS.join(', ')}` });
  }
  
  const repoPath = getRepoPath(repo);
  const sessionId = `build-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`🔨 Starting Zeus build for repository: ${repo}, session: ${sessionId}`);
  
  // Initialize build status
  const buildStatus = {
    status: 'building',
    repo: repo,
    startTime: Date.now(),
    process: null
  };
  
  // Respond immediately with sessionId
  res.json({
    success: true,
    sessionId: sessionId,
    status: 'building'
  });
  
  // Start build in background
  const zeusBuild = spawn('zeus', ['build'], {
    cwd: repoPath,
    shell: true,
    env: { ...process.env }
  });
  
  // Store process in status object
  buildStatus.process = zeusBuild;
  activeProcesses.set(sessionId, buildStatus);
  console.log(`📝 Registered build process for session: ${sessionId}`);
  
  let stdout = '';
  let stderr = '';
  
  zeusBuild.stdout.on('data', (data) => {
    stdout += data.toString();
  });
  
  zeusBuild.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  
  // Safety timeout
  const buildTimeout = setTimeout(() => {
    if (!zeusBuild.killed) {
      console.log(`⏰ Build timeout for ${repo}, killing process`);
      zeusBuild.kill();
      buildStatus.status = 'error';
      buildStatus.error = 'Build timeout after 5 minutes';
    }
  }, 300000); // 5 minutes
  
  // Handle process completion
  zeusBuild.on('close', (code) => {
    clearTimeout(buildTimeout);
    console.log(`🧹 Build process closed for session: ${sessionId}, exit code: ${code}`);
    
    if (code !== 0) {
      buildStatus.status = 'error';
      buildStatus.error = `Build failed with exit code ${code}. ${stderr || stdout}`;
      return;
    }
    
    try {
      const distPath = path.join(repoPath, 'dist');
      
      if (!fs.existsSync(distPath)) {
        throw new Error('dist folder not found after build');
      }
      
      const files = fs.readdirSync(distPath);
      const zabFile = files.find(f => f.endsWith('.zab'));
      
      if (!zabFile) {
        throw new Error('No .zab file found in dist folder');
      }
      
      const zabPath = path.join(distPath, zabFile);
      const zabStats = fs.statSync(zabPath);
      
      console.log(`✅ Build successful for ${repo}: ${zabFile} (${zabStats.size} bytes)`);
      
      buildStatus.status = 'completed';
      buildStatus.filename = zabFile;
      buildStatus.size = zabStats.size;
      buildStatus.path = `/download/${repo}/${zabFile}`;
    } catch (err) {
      console.error(`❌ Build post-processing failed for ${repo}:`, err);
      buildStatus.status = 'error';
      buildStatus.error = err.message;
    }
  });
});

// --- BUILD STATUS ENDPOINT ---
app.get("/build-status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const buildStatus = activeProcesses.get(sessionId);
  
  if (!buildStatus) {
    return res.status(404).json({ 
      success: false, 
      error: 'Build session not found' 
    });
  }
  
  // Return status without the process object
  const { process, ...statusInfo } = buildStatus;
  
  res.json({
    success: true,
    ...statusInfo
  });
  
  // Clean up completed/errored builds after 30 seconds
  if (buildStatus.status === 'completed' || buildStatus.status === 'error') {
    setTimeout(() => {
      activeProcesses.delete(sessionId);
      console.log(`🧹 Cleaned up build session: ${sessionId}`);
    }, 30000);
  }
});


// --- DOWNLOAD ZAB ENDPOINT ---
app.get("/download/:repo/:filename", (req, res) => {
  const { repo, filename } = req.params;
  
  if (!REPOS.includes(repo)) {
    return res.status(404).send('Repository not found');
  }
  
  if (!filename.endsWith('.zab')) {
    return res.status(400).send('Invalid file type');
  }
  
  const zabPath = path.join(getRepoPath(repo), 'dist', filename);
  
  if (!fs.existsSync(zabPath)) {
    return res.status(404).send('File not found');
  }
  
  console.log(`📥 Downloading ${filename} for ${repo}`);
  
  res.download(zabPath, filename, (err) => {
    if (err) {
      console.error('Download error:', err);
      if (!res.headersSent) {
        res.status(500).send('Download failed');
      }
    }
  });
});

// --- MAIN ROUTE (Setup Page) ---
app.get("/", (req, res) => {
  // Get repository name from query parameter, default to first repo
  const repoName = req.query.repo || REPOS[0];
  
  // Get device target from query parameter, default to Amazfit Balance
  const deviceTarget = req.query.device || "Amazfit Balance";
  
  if (!repoName || !REPOS.includes(repoName)) {
    return res.status(400).send(`Invalid repository. Available: ${REPOS.join(', ')}`);
  }

  console.log(`🌐️  Setup page opened - repo: ${repoName}, device: ${deviceTarget}`);

  // Send complete HTML page (no streaming needed for setup page)
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
        <title>Zeus Build - ${repoName}</title>
        <style>
        @import url('https://fontlibrary.org/face/dejavu-sans-mono');
        @import url('https://adobe-fonts.github.io/source-code-pro/source-code-pro.css');

          * {
            box-sizing: border-box;
          }

          body {
            background: #000;
            color: #f0f0f0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 10px;
            width: 100vw;
            min-height: 100vh;
            overflow-x: hidden;
            overflow-y: auto;
            margin: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
          }

          pre {
            font-family: 'Source Code Pro', monospace;
            font-variant-numeric: tabular-nums lining-nums;
            font-kerning:none;
            line-height: ${LINE_HEIGHT_DEFAULT};
            letter-spacing: ${LETTER_SPACING_DEFAULT}px;
            font-size: ${FONT_SIZE_DEFAULT}px;
            background: black;
            padding: 5px;
            display: inline-block;
            white-space: pre;
            overflow-x: auto;
          }
          
          /* Section Containers */
          .section-container {
            margin-bottom: 15px;
            padding: 15px;
            background: #1a1a1a;
            border-radius: 8px;
            width: 100%;
            max-width: 900px;
            border: 1px solid #333;
          }
          .section-container h2 {
            margin: 0 0 15px 0;
            font-size: 16px;
            color: #4CAF50;
            border-bottom: 2px solid #333;
            padding-bottom: 10px;
          }
          
          /* Selector Box */
          .selector-box {
            padding: 10px 0;
          }
          .selector-box label {
            display: block;
            margin-bottom: 8px;
            font-size: 13px;
            color: #aaa;
            font-weight: bold;
          }
          .selector-box select {
            width: 100%;
            padding: 12px;
            background: #2a2a2a;
            color: white;
            border: 1px solid #444;
            border-radius: 5px;
            font-size: 14px;
            cursor: pointer;
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E');
            background-repeat: no-repeat;
            background-position: right 10px top 50%;
            background-size: 12px auto;
            padding-right: 35px;
          }
          .selector-box select:hover {
            background-color: #333;
            border-color: #555;
          }
          .selector-box select:focus {
            outline: none;
            border-color: #4CAF50;
            box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
          }
          
          /* Preview Controls - Mobile First */
          .preview-controls {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .preview-controls .selector-box {
            flex: 1;
            padding: 0;
          }
          .preview-controls .btn {
            width: 100%;
            padding: 14px 20px;
            height: auto;
          }
          
          /* Build Controls - Mobile First */
          .build-controls {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 15px;
          }
          .build-controls .btn {
            width: 100%;
          }
          
          /* Buttons */
          .btn {
            padding: 14px 20px;
            border: none;
            border-radius: 5px;
            font-size: 15px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.2s;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          .btn-start {
            background: #4CAF50;
            color: white;
          }
          .btn-start:hover:not(:disabled),
          .btn-start:active:not(:disabled) {
            background: #45a049;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(76, 175, 80, 0.3);
          }
          .btn-update {
            background: #9C27B0;
            color: white;
          }
          .btn-update:hover:not(:disabled),
          .btn-update:active:not(:disabled) {
            background: #7B1FA2;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(156, 39, 176, 0.3);
          }
          .btn-build {
            background: #FF9800;
            color: white;
          }
          .btn-build:hover:not(:disabled),
          .btn-build:active:not(:disabled) {
            background: #F57C00;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(255, 152, 0, 0.3);
          }
          .btn-abort {
            background: #f44336;
            color: white;
          }
          .btn-abort:hover:not(:disabled),
          .btn-abort:active:not(:disabled) {
            background: #da190b;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(244, 67, 54, 0.3);
          }
          .btn-download {
            background: #2196F3;
            color: white;
            margin-top: 10px;
          }
          .btn-download:hover:not(:disabled),
          .btn-download:active:not(:disabled) {
            background: #0b7dda;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(33, 150, 243, 0.3);
          }
          .btn:disabled {
            background: #555;
            color: #888;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
          }
          
          /* Build Result */
          .build-result {
            padding: 15px;
            background: #2a2a2a;
            border-radius: 5px;
            border: 1px solid #444;
          }
          .update-result {
            padding: 15px;
            background: #2a2a2a;
            border-radius: 5px;
            border: 1px solid #444;
            margin-top: 15px;
          }
          #update-info {
            padding: 10px;
            background: #222;
            border-radius: 3px;
            font-family: monospace;
            font-size: 13px;
            line-height: 1.5;
            word-break: break-word;
          }
          #build-info {
            padding: 10px;
            background: #222;
            border-radius: 3px;
            margin-bottom: 10px;
            font-family: monospace;
            font-size: 13px;
            line-height: 1.5;
            word-break: break-word;
          }
          #build-info.success {
            color: #4CAF50;
            border-left: 4px solid #4CAF50;
          }
          #build-info.error {
            color: #f44336;
            border-left: 4px solid #f44336;
          }
          #build-info.building {
            color: #FFC107;
            border-left: 4px solid #FFC107;
            animation: pulse 2s infinite;
          }
          
          /* Status */
          .status { 
            color: #4CAF50; 
            margin-bottom: 10px; 
            text-align: center;
            padding: 12px;
            background: #333;
            border-radius: 5px;
            width: 100%;
            max-width: 900px;
            font-size: 14px;
          }
          .status.building {
            color: #FFC107;
            animation: pulse 2s infinite;
          }
          .status.ready {
            color: #4CAF50;
          }
          .status.error {
            color: #f44336;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
          
          /* ========================================
             RESPONSIVE BREAKPOINTS
             ======================================== */
          
          /* Tablet Portrait (600px+) */
          @media (min-width: 600px) {
            body {
              padding: 20px;
            }
            
            .section-container {
              margin-bottom: 20px;
              padding: 20px;
            }
            
            .section-container h2 {
              font-size: 18px;
            }
            
            .selector-box label {
              font-size: 14px;
            }
            
            .selector-box select {
              font-size: 15px;
              padding: 10px;
            }
            
            .btn {
              font-size: 16px;
              padding: 12px 25px;
            }
            
            .status {
              font-size: 15px;
            }
            
            #build-info {
              font-size: 14px;
            }
          }
          
          /* Tablet Landscape & Desktop (900px+) */
          @media (min-width: 900px) {
            /* Preview Controls - Side by Side */
            .preview-controls {
              flex-direction: row;
              align-items: flex-end;
              gap: 15px;
            }
            .preview-controls .btn {
              flex-shrink: 0;
              width: auto;
              padding: 10px 30px;
              height: 44px;
            }
            
            /* Build Controls - Side by Side */
            .build-controls {
              flex-direction: row;
              gap: 15px;
            }
            .build-controls .btn {
              flex: 1;
            }
          }
          
          /* Large Desktop (1200px+) */
          @media (min-width: 1200px) {
            body {
              padding: 30px;
            }
          }
        </style>
      </head>

      <body>
        <!-- 1. Project Selection Container -->
        <div class="section-container">
          <h2>📦 Project Selection</h2>
          <div class="selector-box">
            <label for="repo-select">Repository:</label>
            <select id="repo-select">
              ${REPOS.map(r => `<option value="${r}" ${r === repoName ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
        </div>
        
        <!-- 2. Preview Container -->
        <div class="section-container">
          <h2>▶️ Preview on Device</h2>
          <div class="preview-controls">
            <div class="selector-box">
              <label for="device-select">Target Device:</label>
              <select id="device-select">
                ${availableDevices.map(d => `<option value="${d}" ${d === deviceTarget ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-start" onclick="startPreview()">▶️ Start Preview</button>
          </div>
        </div>
        
        <!-- 3. Update Repository Container -->
        <div class="section-container">
          <h2>🔄 Update Repository</h2>
          <div class="update-controls">
            <button class="btn btn-update" onclick="updateRepo()">🔄 Update from Git</button>
          </div>
          <div class="update-result" id="update-result" style="display: none;">
            <div id="update-info"></div>
          </div>
        </div>
        
        <!-- 4. Build Distribution Container -->
        <div class="section-container">
          <h2>📦 Build Distribution Package</h2>
          <div class="build-controls">
            <button class="btn btn-build" id="btn-build" onclick="buildZab()">🔨 Build .zab Package</button>
            <button class="btn btn-abort" id="btn-abort-build" onclick="abortBuild()" style="display: none;">⏹️ Abort Build</button>
          </div>
          
          <div class="build-result" id="build-result" style="display: none;">
            <div id="build-info"></div>
            <button class="btn btn-download" id="btn-download" onclick="downloadZab()" style="display: none;">⬇️ Download .zab</button>
          </div>
        </div>
        
        <div class="status ready" id="status">
          ✅ Ready! Select a repository, then choose an action.
        </div>
        
        <script>
          let currentZabPath = null;
          let currentBuildSessionId = null;
          
          function startPreview() {
            const repo = document.getElementById('repo-select').value;
            const device = document.getElementById('device-select').value;
            window.location.href = '/preview?repo=' + encodeURIComponent(repo) + '&device=' + encodeURIComponent(device);
          }
          
          function buildZab() {
            const repo = document.getElementById('repo-select').value;
            
            const buildBtn = document.getElementById('btn-build');
            const abortBtn = document.getElementById('btn-abort-build');
            const buildResult = document.getElementById('build-result');
            const buildInfo = document.getElementById('build-info');
            const downloadBtn = document.getElementById('btn-download');
            
            buildBtn.disabled = true;
            buildBtn.innerText = '⏳ Building...';
            abortBtn.disabled = false;
            abortBtn.style.display = 'inline-block';
            
            buildResult.style.display = 'block';
            buildInfo.className = 'building';
            buildInfo.innerText = 'Building .zab file, please wait...';
            downloadBtn.style.display = 'none';
            
            fetch('/build', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ repo: repo })
            })
            .then(response => response.json())
            .then(data => {
              if (!data.success) {
                buildInfo.className = 'error';
                buildInfo.innerHTML = '❌ Build failed!<br>Error: ' + data.error;
                buildBtn.disabled = false;
                buildBtn.innerText = '🔨 Build .zab';
                abortBtn.style.display = 'none';
                return;
              }
              
              // Save session ID and start polling
              currentBuildSessionId = data.sessionId;
              console.log('Build started, session:', currentBuildSessionId);
              pollBuildStatus();
            })
            .catch(err => {
              console.error('Build request failed:', err);
              buildInfo.className = 'error';
              buildInfo.innerHTML = '❌ Build request failed!<br>Error: ' + err.message;
              buildBtn.disabled = false;
              buildBtn.innerText = '🔨 Build .zab';
              abortBtn.style.display = 'none';
            });
          }
          
          function pollBuildStatus() {
            if (!currentBuildSessionId) return;
            
            fetch('/build-status/' + currentBuildSessionId)
              .then(response => response.json())
              .then(data => {
                if (!data.success) {
                  console.error('Status check failed:', data.error);
                  currentBuildSessionId = null;
                  document.getElementById('btn-build').disabled = false;
                  document.getElementById('btn-build').innerText = '🔨 Build .zab';
                  document.getElementById('btn-abort-build').style.display = 'none';
                  return;
                }
                
                const buildInfo = document.getElementById('build-info');
                
                if (data.status === 'building') {
                  // Still building, poll again in 1 second
                  setTimeout(pollBuildStatus, 1000);
                } else if (data.status === 'completed') {
                  // Build completed successfully
                  buildInfo.className = 'success';
                  buildInfo.innerHTML = '✅ Build successful!<br>File: ' + data.filename + '<br>Size: ' + formatBytes(data.size);
                  currentZabPath = data.path;
                  document.getElementById('btn-download').style.display = 'inline-block';
                  document.getElementById('btn-build').disabled = false;
                  document.getElementById('btn-build').innerText = '🔨 Build .zab';
                  document.getElementById('btn-abort-build').style.display = 'none';
                  currentBuildSessionId = null;
                } else if (data.status === 'error') {
                  // Build failed
                  buildInfo.className = 'error';
                  buildInfo.innerHTML = '❌ Build failed!<br>Error: ' + data.error;
                  document.getElementById('btn-build').disabled = false;
                  document.getElementById('btn-build').innerText = '🔨 Build .zab';
                  document.getElementById('btn-abort-build').style.display = 'none';
                  currentBuildSessionId = null;
                }
              })
              .catch(err => {
                console.error('Status poll failed:', err);
                // Keep polling on network errors
                setTimeout(pollBuildStatus, 2000);
              });
          }
          
          function abortBuild() {
            if (!currentBuildSessionId) {
              console.log('No active build to abort');
              return;
            }
            
            const abortBtn = document.getElementById('btn-abort-build');
            abortBtn.disabled = true;
            abortBtn.innerText = '⏳ Aborting...';
            
            fetch('/abort', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Session-ID': currentBuildSessionId
              }
            })
            .then(response => response.json())
            .then(data => {
              console.log('Abort response:', data);
              document.getElementById('build-info').className = 'error';
              document.getElementById('build-info').innerHTML = '⏹️ Build aborted';
              document.getElementById('btn-build').disabled = false;
              document.getElementById('btn-build').innerText = '🔨 Build .zab';
              abortBtn.style.display = 'none';
              abortBtn.disabled = false;
              abortBtn.innerText = '⏹️ Abort Build';
              currentBuildSessionId = null;
            })
            .catch(err => {
              console.error('Abort failed:', err);
              abortBtn.disabled = false;
              abortBtn.innerText = '⏹️ Abort Build';
            });
          }
          
          function updateRepo() {
            const repo = document.getElementById('repo-select').value;
            if (!repo) {
              document.getElementById('status').innerText = '⚠️ Please select a repository first';
              document.getElementById('status').className = 'status warning';
              return;
            }
            
            const updateResult = document.getElementById('update-result');
            const updateInfo = document.getElementById('update-info');
            
            updateResult.style.display = 'block';
            updateInfo.innerHTML = '<div class="loading">🔄 Updating repository...</div>';
            
            document.getElementById('status').innerText = '🔄 Updating repository from Git...';
            document.getElementById('status').className = 'status building';
            
            fetch('/update-repo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: repo })
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
              if (data.success) {
                var commitInfo = data.commit 
                  ? '<br><small>Commit: ' + data.commit.substring(0, 7) + '</small>' 
                  : '';
                
                updateInfo.innerHTML = 
                  '<div class="success-message">' +
                    '✅ ' + data.message + commitInfo +
                  '</div>';
                
                document.getElementById('status').innerText = '✅ Repository "' + repo + '" updated successfully';
                document.getElementById('status').className = 'status ready';
              } else {
                updateInfo.innerHTML = 
                  '<div class="error-message">' +
                    '❌ Update failed: ' + data.error +
                  '</div>';
                
                document.getElementById('status').innerText = '❌ Update failed';
                document.getElementById('status').className = 'status error';
              }
            })
            .catch(function(err) {
              updateInfo.innerHTML = 
                '<div class="error-message">' +
                  '❌ Error: ' + err.message +
                '</div>';
              
              document.getElementById('status').innerText = '❌ Update error';
              document.getElementById('status').className = 'status error';
            });
          }
          
          function downloadZab() {
            if (!currentZabPath) {
              alert('No file available for download');
              return;
            }
            window.location.href = currentZabPath;
          }
          
          function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
          }
        </script>
  </body>
</html>
  `);
});

// --- WEBHOOK ENDPOINT ---
app.post("/", bodyParser.raw({ type: "*/*" }), async (req, res) => {
  if (!verifySignature(req)) {
    console.log("⛔ Invalid signature!");
    return res.status(403).send("Invalid signature");
  }

  const payload = JSON.parse(req.body.toString());
  const branch = payload.ref?.replace("refs/heads/", "");
  const repoFullName = payload.repository.full_name;
  const repoName = payload.repository.name;
  
  console.log(`📮 Webhook received for repository: ${repoName}, branch: ${branch}`);

  // Check if repository is in configured list
  if (!REPOS.includes(repoName)) {
    console.log(`⚠️  Repository ${repoName} not in configured list, ignoring`);
    return res.send("Repository not configured");
  }

  if (branch !== "main") {
    console.log("⏭️  Branch ignored (not main).");
    return res.send("Branch ignored");
  }

  const result = await updateRepository(repoName, branch);

  if (result.success) {
    res.send(`OK: Updated to ${result.commit}`);
  } else {
    res.status(500).send(`Update error: ${result.error}`);
  }
});

// --- PREVIEW ROUTE (Always runs Zeus preview) ---
app.get("/preview", (req, res) => {
  const repoName = req.query.repo || REPOS[0];
  const deviceTarget = req.query.device || "Amazfit Balance";
  
  // Generate unique session ID for this preview
  const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  if (!repoName || !REPOS.includes(repoName)) {
    return res.status(400).send(`Invalid repository. Available: ${REPOS.join(', ')}`);
  }

  const repoPath = getRepoPath(repoName);

  console.log(`🎬 Preview started - repo: ${repoName}, device: ${deviceTarget}, session: ${sessionId}`);

  // HTML header for streaming
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Transfer-Encoding": "chunked"
  });

  res.write(`
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
        <title>Zeus Preview - ${repoName}</title>
        <style>
        @import url('https://fontlibrary.org/face/dejavu-sans-mono');
        @import url('https://adobe-fonts.github.io/source-code-pro/source-code-pro.css');

          * {
            box-sizing: border-box;
          }

          body {
            background: #000;
            color: #f0f0f0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 10px;
            width: 100vw;
            min-height: 100vh;
            overflow-x: hidden;
            overflow-y: auto;
            margin: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
          }

          pre {
            font-family: 'Source Code Pro', monospace;
            font-variant-numeric: tabular-nums lining-nums;
            font-kerning:none;
            line-height: ${LINE_HEIGHT_DEFAULT};
            letter-spacing: ${LETTER_SPACING_DEFAULT}px;
            font-size: ${FONT_SIZE_DEFAULT}px;
            background: black;
            padding: 5px;
            display: inline-block;
            white-space: pre;
            overflow-x: auto;
            max-width: 100%;
          }
          
          .header {
            margin-bottom: 15px;
            padding: 15px;
            background: #222;
            border-radius: 5px;
            text-align: center;
            width: 100%;
            max-width: 900px;
          }
          
          .header h2 {
            margin: 0 0 10px 0;
            color: #4CAF50;
            font-size: 18px;
          }
          
          .header p {
            margin: 5px 0;
            color: #aaa;
            font-size: 13px;
            word-break: break-word;
          }
          
          .header p strong {
            color: #fff;
          }
          
          .btn {
            margin: 8px 5px;
            padding: 12px 20px;
            border: none;
            border-radius: 5px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.2s;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
            display: inline-block;
          }
          
          .btn-abort {
            background: #f44336;
            color: white;
          }
          
          .btn-abort:hover,
          .btn-abort:active {
            background: #da190b;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(244, 67, 54, 0.3);
          }
          
          .btn-back {
            background: #666;
            color: white;
          }
          
          .btn-back:hover,
          .btn-back:active {
            background: #777;
          }
          
          .controls { 
            margin-bottom: 15px; 
            padding: 15px; 
            background: #333; 
            border-radius: 5px; 
            text-align: center;
            width: 100%;
            max-width: 900px;
          }
          .controls h3 {
            margin: 0 0 15px 0;
            color: #FF9800;
            font-size: 16px;
          }
          .controls button { 
            margin: 3px; 
            padding: 8px 12px; 
            background: #555; 
            border: none; 
            color: white; 
            cursor: pointer;
            border-radius: 3px;
            font-size: 12px;
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
          }
          .controls button:hover,
          .controls button:active {
            background: #666;
          }
          .control-row {
            margin-bottom: 10px;
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            align-items: center;
            gap: 5px;
          }
          .control-row span {
            width: 100px;
            display: inline-block;
            font-family: monospace;
            font-size: 12px;
          }
          
          /* ========================================
             RESPONSIVE BREAKPOINTS
             ======================================== */
          
          /* Tablet Portrait (600px+) */
          @media (min-width: 600px) {
            body {
              padding: 20px;
            }
            
            .header {
              margin-bottom: 20px;
              padding: 20px;
            }
            
            .header h2 {
              font-size: 20px;
            }
            
            .header p {
              font-size: 14px;
            }
            
            .btn {
              margin: 10px 5px;
              padding: 12px 25px;
              font-size: 15px;
            }
            
            .controls {
              margin-bottom: 20px;
              padding: 20px;
            }
            
            .controls h3 {
              font-size: 18px;
            }
            
            .controls button {
              margin: 5px;
              padding: 8px 15px;
              font-size: 13px;
            }
            
            .control-row span {
              font-size: 13px;
            }
          }
          
          /* Tablet Landscape & Desktop (900px+) */
          @media (min-width: 900px) {
            .btn {
              font-size: 16px;
            }
            
            .controls button {
              padding: 5px 10px;
              font-size: 14px;
            }
            
            .control-row span {
              font-size: 14px;
            }
          }
          
          /* Large Desktop (1200px+) */
          @media (min-width: 1200px) {
            body {
              padding: 30px;
            }
          }
        </style>
      </head>

      <body>
        <script>
          const SESSION_ID = '${sessionId}';
          
          function abortPreview() {
            const abortBtn = document.getElementById('btn-abort');
            if (abortBtn) {
              abortBtn.disabled = true;
              abortBtn.innerText = '⏳ Aborting...';
            }
            
            fetch('/abort', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Session-ID': SESSION_ID
              }
            })
            .then(response => response.json())
            .then(data => {
              console.log('Abort response:', data);
              setTimeout(() => {
                window.location.href = '/?repo=${encodeURIComponent(repoName)}&device=${encodeURIComponent(deviceTarget)}';
              }, 500);
            })
            .catch(err => {
              console.error('Abort failed:', err);
              window.location.href = '/';
            });
          }
          
          function backToSetup() {
            window.location.href = '/?repo=${encodeURIComponent(repoName)}&device=${encodeURIComponent(deviceTarget)}';
          }
          
          function setCookie(name, value) {
            const d = new Date();
            d.setTime(d.getTime() + (30*24*60*60*1000));
            let expires = "expires=" + d.toUTCString();
            document.cookie = name + "=" + value + ";" + expires + ";path=/";
          }

          function getCookie(name) {
            let nameEQ = name + "=";
            let ca = document.cookie.split(';');
            for(let i = 0; i < ca.length; i++) {
                let c = ca[i];
                while (c.charAt(0) === ' ') c = c.substring(1, c.length);
                if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
            }
            return null;
          }

          let currentLineHeight = parseFloat(${LINE_HEIGHT_DEFAULT});
          let currentFontSize = parseInt(${FONT_SIZE_DEFAULT});
          let currentLetterSpacing = parseFloat(${LETTER_SPACING_DEFAULT});

          if (getCookie('qr_lh')) {
              currentLineHeight = parseFloat(getCookie('qr_lh'));
          }
          if (getCookie('qr_fs')) {
              currentFontSize = parseInt(getCookie('qr_fs'));
          }
          if (getCookie('qr_ls')) {
              currentLetterSpacing = parseFloat(getCookie('qr_ls'));
          }

          function updateCSS() {
            const pre = document.getElementById('log-output');
            if (!pre) return;

            document.getElementById('lh-display').innerText = \`LH: \${currentLineHeight.toFixed(2)}\`;
            document.getElementById('fs-display').innerText = \`FS: \${currentFontSize}px\`;
            document.getElementById('ls-display').innerText = \`LS: \${currentLetterSpacing.toFixed(2)}px\`;

            pre.style.lineHeight = currentLineHeight.toFixed(2);
            pre.style.fontSize = \`\${currentFontSize}px\`;
            pre.style.letterSpacing = \`\${currentLetterSpacing.toFixed(2)}px\`;

            setCookie('qr_lh', currentLineHeight.toFixed(2));
            setCookie('qr_fs', currentFontSize);
            setCookie('qr_ls', currentLetterSpacing.toFixed(2));
          }

          function changeParam(param, delta) {
            if (param === 'lineHeight') {
              currentLineHeight = Math.round((currentLineHeight + delta) * 100) / 100;
              currentLineHeight = Math.min(2.0, Math.max(0.5, currentLineHeight));
            } else if (param === 'fontSize') {
              currentFontSize = Math.min(20, Math.max(5, currentFontSize + delta));
            } else if (param === 'letterSpacing') {
              currentLetterSpacing = Math.round((currentLetterSpacing + delta) * 100) / 100;
              currentLetterSpacing = Math.min(5, Math.max(-5, currentLetterSpacing));
            }
            updateCSS();
          }
          
          window.onload = updateCSS;
        </script>
        
        <div class="header">
          <h2>⏳ Zeus Preview Running</h2>
          <p>📦 Repository: <strong>${repoName}</strong></p>
          <p>⌚ Device: <strong>${deviceTarget}</strong></p>
          <button class="btn btn-abort" id="btn-abort" onclick="abortPreview()">⏹️ Abort Preview</button>
          <button class="btn btn-back" onclick="backToSetup()">⬅️ Back to Setup</button>
        </div>
        
        <div class="controls">
          <h3>🎛️ QR Code Display Fine Tuning</h3>
          <div class="control-row">
            <button onclick="changeParam('lineHeight', -0.01)">Line Height -</button>
            <span id="lh-display" style="width: 100px; display: inline-block;">LH: ${LINE_HEIGHT_DEFAULT}</span>
            <button onclick="changeParam('lineHeight', 0.01)">Line Height +</button>
          </div>
          <div class="control-row">
            <button onclick="changeParam('fontSize', -1)">Font Size -</button>
            <span id="fs-display" style="width: 100px; display: inline-block;">FS: ${FONT_SIZE_DEFAULT}px</span>
            <button onclick="changeParam('fontSize', 1)">Font Size +</button>
          </div>
          <div class="control-row">
            <button onclick="changeParam('letterSpacing', -0.01)">Letter Spacing -</button>
            <span id="ls-display" style="width: 100px; display: inline-block;">LS: ${LETTER_SPACING_DEFAULT}px</span>
            <button onclick="changeParam('letterSpacing', 0.01)">Letter Spacing +</button>
          </div>
        </div>
        
        <pre id="log-output">
  `);

  // Start zeus immediately
  const zeus = spawn("zeus", ["preview", "--target", `"${deviceTarget}"`], {
    cwd: repoPath,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" }
  });
  
  // Store process in active processes map for this session
  activeProcesses.set(sessionId, zeus);
  console.log(`📝 Registered Zeus process for session: ${sessionId}`);

  // Safety timer: kill process after 5 minutes (300 seconds)
  const killer = setTimeout(() => {
    if (!zeus.killed) {
        zeus.kill();
        activeProcesses.delete(sessionId);
        res.write("\n\n--- TIMEOUT: Process terminated after 5 minutes. Click 'Back to Setup' to try again. ---");
        res.end();
    }
  }, 300000);

  // Handle output
  zeus.stdout.on("data", (data) => {
    let text = data.toString();
    text = text.replace(ansiRegex(), '');
    res.write(text);
  });

  zeus.stderr.on("data", (data) => {
    res.write(`ERROR: ${data.toString()}`);
  });

  zeus.on("close", (code) => {
    clearTimeout(killer);
    
    // Remove from active processes
    activeProcesses.delete(sessionId);
    console.log(`🧹 Zeus process closed for session: ${sessionId}, exit code: ${code}`);
    
    res.write(`
  <script>
    // Re-enable buttons after process completes
    const abortBtn = document.getElementById('btn-abort');
    if (abortBtn) {
      abortBtn.disabled = true;
      abortBtn.innerText = '✓ Preview Completed';
    }
  </script>
  </pre></body></html>`);
    res.end();
  });
  
  // Clean up if client disconnects before build completes
  req.on('close', () => {
    if (!zeus.killed && activeProcesses.has(sessionId)) {
      console.log(`🔌 Client disconnected, killing Zeus process for session: ${sessionId}`);
      zeus.kill();
      activeProcesses.delete(sessionId);
      clearTimeout(killer);
    }
  });
});

// --- HEALTH CHECK ENDPOINT ---
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    repositories: REPOS,
    workspace: WORKSPACE_DIR,
    timestamp: new Date().toISOString()
  });
});

// --- LIST REPOSITORIES ENDPOINT ---
app.get("/repos", (req, res) => {
  res.status(200).json({
    configured_repositories: REPOS,
    workspace_path: WORKSPACE_DIR
  });
});

// --- UPDATE REPOSITORY ENDPOINT ---
app.post("/update-repo", bodyParser.json(), async (req, res) => {
  const { repo } = req.body;

  if (!repo) {
    return res.status(400).json({
      success: false,
      error: "Repository name is required"
    });
  }

  if (!REPOS.includes(repo)) {
    return res.status(404).json({
      success: false,
      error: `Repository '${repo}' not found in configuration`
    });
  }

  console.log(`[UPDATE] Manual update requested for repository: ${repo}`);

  try {
    const result = await updateRepository(repo);
    
    if (result.success) {
      res.status(200).json({
        success: true,
        message: `Repository '${repo}' updated successfully`,
        commit: result.commit
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (err) {
    console.error(`[UPDATE] Error updating ${repo}:`, err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Start server only if run directly (not required)
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("========================================");
    console.log("  🚀 ZeppOS Development Server Started");
    console.log("========================================");
    console.log(`Port: ${PORT}`);
    console.log(`Repositories: ${REPOS.join(', ') || 'None configured'}`);
    console.log(`Workspace: ${WORKSPACE_DIR}`);
    console.log("");
    console.log("📍 Available Endpoints:");
    console.log("");
    console.log("  Web Interface:");
    console.log(`    GET  /                        Setup page (repo/device selection)`);
    console.log(`    GET  /preview                 Preview on device (with QR code)`);
    console.log("");
    console.log("  Build & Distribution:");
    console.log(`    POST /build                   Build .zab package (async)`);
    console.log(`    GET  /build-status/:id        Poll build status`);
    console.log(`    GET  /download/:repo/:file    Download .zab file`);
    console.log("");
    console.log("  Process Control:");
    console.log(`    POST /abort                   Abort build/preview process`);
    console.log("");
    console.log("  GitHub Integration:");
    console.log(`    POST /                        GitHub webhook receiver`);
    console.log("");
    console.log("  System:");
    console.log(`    GET  /health                  Health check`);
    console.log(`    GET  /repos                   List configured repositories`);
    console.log("");
    console.log("========================================");
    console.log(`🌐 Open in browser: http://localhost:${PORT}/`);
    console.log("========================================");
  });
}

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Export functions for entrypoint
module.exports.ensureRepo = ensureRepo;
module.exports.runInitialUpdate = runInitialUpdate;
