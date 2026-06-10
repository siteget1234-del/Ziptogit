import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import AdmZip from "adm-zip";
import { Octokit } from "@octokit/rest";
import axios from "axios";

// IMPORTANT: You provided these in chat. For a production app, use environment variables and remove them from here.
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "Ov23liT2aEMF0F7zAifI";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "58ed7be009442b41a02e024830e187be2d009610";

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- Auth Routes ---
  app.get("/api/auth/url", (req, res) => {
    // Determine the base redirect URI dynamically
    // In dev, the APP_URL comes from the environment.  However, we can just let
    // the frontend pass the redirect URI because window.location.origin is stable.
    const redirectUri = req.query.redirectUri as string;

    if (!redirectUri) {
      return res.status(400).json({ error: "Missing redirectUri parameter" });
    }

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "repo user",
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    res.json({ url: authUrl });
  });

  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("No code provided.");
    }

    try {
      // Exchange code for access token
      const response = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code: code,
        },
        {
          headers: {
            Accept: "application/json",
          },
        }
      );

      const accessToken = response.data.access_token;

      if (!accessToken) {
        return res.status(400).send("Failed to retrieve access token.");
      }

      // Send success message to parent window and close popup
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', token: '${accessToken}' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("OAuth error:", error);
      res.status(500).send("Authentication failed");
    }
  });

  // --- API Routes ---
  
  // Endpoint to get user's repositories
  app.get("/api/github/repos", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

    const token = authHeader.split(" ")[1];
    const octokit = new Octokit({ auth: token });

    try {
      const { data } = await octokit.rest.repos.listForAuthenticatedUser({
        visibility: "all",
        sort: "updated",
        per_page: 100,
      });
      res.json(data);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint to handle zip upload and automatic commit
  app.post("/api/github/push", upload.single("file"), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

    const owner = req.body.owner;
    const repo = req.body.repo;
    const branch = req.body.branch || "main";
    const commitMessage = req.body.commitMessage || "Initial commit from AI Studio Zip Sync";
    const file = req.file;

    if (!owner || !repo || !file) {
      return res.status(400).json({ error: "Missing required fields: owner, repo, or file" });
    }

    const token = authHeader.split(" ")[1];
    const octokit = new Octokit({ auth: token });

    try {
      // 1. Read ZIP contents
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      const filesToCommit: { path: string, content: string | Buffer }[] = [];

      for (const entry of zipEntries) {
         if (!entry.isDirectory) {
            // Fix paths if the zip puts everything in a root folder
            // Often AI Studio zips have a single root folder, e.g. "my-app-name/src/..."
            // We want to strip the first directory if there is one common base
            filesToCommit.push({
               path: entry.entryName,
               content: entry.getData() // Buffer
            });
         }
      }

      if (filesToCommit.length === 0) {
         return res.status(400).json({ error: "Zip file is empty" });
      }

      // Check for common root directory and remove it if present
      let commonRoot = "";
      const firstPathParts = filesToCommit[0].path.split("/");
      if (firstPathParts.length > 1) {
         const possibleRoot = firstPathParts[0] + "/";
         let allShareRoot = filesToCommit.every(f => f.path.startsWith(possibleRoot));
         if (allShareRoot) {
            commonRoot = possibleRoot;
         }
      }
      
      const adjustedFiles = filesToCommit.map(f => ({
         ...f,
         path: f.path.startsWith(commonRoot) ? f.path.substring(commonRoot.length) : f.path
      }));

      // 2. Get latest commit SHA for the branch
      let baseTreeSha: string;
      let parentCommitSha: string | null = null;
      
      try {
         const { data: refData } = await octokit.rest.git.getRef({
             owner,
             repo,
             ref: `heads/${branch}`
         });
         parentCommitSha = refData.object.sha;
         
         const { data: commitData } = await octokit.rest.git.getCommit({
             owner,
             repo,
             commit_sha: parentCommitSha
         });
         baseTreeSha = commitData.tree.sha;
      } catch (e: any) {
         if (e.status === 404 || e.status === 409) {
            // Branch doesn't exist or repo is completely empty
            // We'll proceed without a base tree
            baseTreeSha = "";
         } else {
            throw e;
         }
      }

      // 3. Create blobs for each file and build the tree structure
      const treeEntries: any[] = [];
      
      for (const f of adjustedFiles) {
         const isText = (f.path.endsWith('.txt') || f.path.endsWith('.js') || f.path.endsWith('.ts') || f.path.endsWith('.tsx') || f.path.endsWith('.jsx') || f.path.endsWith('.html') || f.path.endsWith('.css') || f.path.endsWith('.json') || f.path.endsWith('.md'));
         
         // GitHub allows creating blob from base64 encoding
         const encoding = "base64";
         // To make it simple, we'll upload everything as base64
         const contentBase64 = (f.content as Buffer).toString("base64");
         
         const { data: blobData } = await octokit.rest.git.createBlob({
             owner,
             repo,
             content: contentBase64,
             encoding: "base64"
         });
         
         treeEntries.push({
             path: f.path,
             mode: "100644", // standard file mode
             type: "blob",
             sha: blobData.sha
         });
      }

      // 4. Create the new tree
      const { data: newTree } = await octokit.rest.git.createTree({
         owner,
         repo,
         tree: treeEntries,
         ...(baseTreeSha ? { base_tree: baseTreeSha } : {})
      });

      // 5. Create a new commit
      const { data: newCommit } = await octokit.rest.git.createCommit({
         owner,
         repo,
         message: commitMessage,
         tree: newTree.sha,
         parents: parentCommitSha ? [parentCommitSha] : []
      });

      // 6. Update the reference
      if (parentCommitSha) {
         // Update existing branch
         await octokit.rest.git.updateRef({
             owner,
             repo,
             ref: `heads/${branch}`,
             sha: newCommit.sha
         });
      } else {
         // Create new repo branch reference if it was totally empty
         await octokit.rest.git.createRef({
             owner,
             repo,
             ref: `refs/heads/${branch}`,
             sha: newCommit.sha
         });
      }

      res.json({ success: true, commitSha: newCommit.sha, branch, url: `https://github.com/${owner}/${repo}/tree/${branch}` });

    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message || "Failed to push to GitHub" });
    }
  });


  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
