import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.disable('x-powered-by');

  // Basic security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Add the oauth auth route
  app.get("/api/auth/url", (req, res) => {
    const redirectUri = `${process.env.APP_URL}/auth/callback`;
    const state = req.query.state as string || "";
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID || "",
      redirect_uri: redirectUri,
      scope: "repo", // "repo" gets complete read/write access to public and private repositories
      state,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    res.json({ url: authUrl });
  });

  // Handle the callback
  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const code = req.query.code as string;
    const state = (req.query.state as string) || "";
    
    if (!code) {
      return res.status(400).send("No code provided.");
    }
    
    try {
      const redirectUri = `${process.env.APP_URL}/auth/callback`;
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        })
      });
      
      const tokenData = await tokenResponse.json() as { access_token?: string, error_description?: string };
      
      if (tokenData.access_token) {
        // Successful authentication
        res.send(`
          <html>
            <body>
              <script>
                try {
                  localStorage.setItem("github_token", "${tokenData.access_token}");
                } catch (e) {
                  console.warn("Failed to set localStorage", e);
                }
                if (window.opener) {
                  try {
                    const safeState = '${state}'.replace(/'/g, "\\'");
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', token: '${tokenData.access_token}', state: safeState }, '*');
                    window.close();
                  } catch (e) {
                    window.location.href = '/';
                  }
                } else {
                  window.location.href = '/';
                }
              </script>
              <p>Authentication successful. You can close this window.</p>
            </body>
          </html>
        `);
      } else {
        res.send(`Authentication failed: ${tokenData.error_description || JSON.stringify(tokenData)}`);
      }
    } catch (error) {
      res.send(`Authentication error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Vite middleware for development
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
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
