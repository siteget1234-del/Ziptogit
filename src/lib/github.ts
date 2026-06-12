import { Octokit } from "octokit";
import JSZip from "jszip";

export interface ExtractedFile {
  path: string;
  content: string; // base64 encoded
}

export const extractZip = async (
  file: File,
  onProgress?: (filename: string) => void
): Promise<ExtractedFile[]> => {
  const result: ExtractedFile[] = [];
  const zip = await JSZip.loadAsync(file);
  
  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, zipEntry) => {
    // Skip empty directories and __MACOSX system folders often found in zip
    if (!zipEntry.dir && !relativePath.includes("__MACOSX") && !relativePath.startsWith(".DS_Store")) {
      // Prevent Zip Slip vulnerability
      if (relativePath.includes("../") || relativePath.includes("..\\") || relativePath.startsWith("/")) {
        return;
      }
      entries.push({ path: relativePath, entry: zipEntry });
    }
  });

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (onProgress) onProgress(item.path);
    const base64Content = await item.entry.async("base64");
    result.push({
      path: item.path,
      content: base64Content,
    });
    // Yield to the event loop periodically to keep the UI responsive for large zips
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return result;
};

export const fetchRepositories = async (token: string) => {
  const octokit = new Octokit({ auth: token });
  // Fetch user repos (up to 100). For more robust apps, pagination would be used.
  return await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    sort: "updated",
    per_page: 100,
  });
};

export const fetchUser = async (token: string) => {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  return data;
};

export const uploadToGitHub = async (
  token: string,
  owner: string,
  repo: string,
  files: ExtractedFile[],
  commitMessage: string,
  onProgress: (status: string, current: number, total: number) => void
) => {
  const octokit = new Octokit({ auth: token });
  const totalSteps = files.length + 3; // 1 for branch info, 'files.length' for blobs, 1 for tree, 1 for commit
  let currentStep = 0;

  try {
    // 1. Get default branch and latest commit
    onProgress("Fetching repository details...", ++currentStep, totalSteps);
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch || 'main'; // Fallback to main
    const branchRef = `heads/${defaultBranch}`;
    
    let commitSha: string | null = null;
    let baseTreeSha: string | undefined = undefined;

    try {
      const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: branchRef,
      });
      commitSha = refData.object.sha;

      const { data: commitData } = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha,
      });
      baseTreeSha = commitData.tree.sha;
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 404) {
        throw e;
      }
      console.warn("Repository appears empty. Initializing with first commit.");
    }

    // Retry helper for API robustness
    const createBlobWithRetry = async (file: ExtractedFile, retries = 3, delay = 1000): Promise<any> => {
      try {
        const { data } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: "base64",
        });
        return data;
      } catch (err: any) {
        if (retries > 0 && (err.status === 403 || err.status >= 500)) {
          const waitTime = err.response?.headers?.['retry-after'] 
            ? parseInt(err.response.headers['retry-after'], 10) * 1000 
            : delay;
          await new Promise(r => setTimeout(r, waitTime || delay));
          return createBlobWithRetry(file, retries - 1, delay * 2);
        }
        throw err;
      }
    };

    // 3. Upload blobs (Chunked)
    const treeItems: any[] = [];
    const MAX_CONCURRENT_UPLOADS = 5;
    
    for (let i = 0; i < files.length; i += MAX_CONCURRENT_UPLOADS) {
      const batch = files.slice(i, i + MAX_CONCURRENT_UPLOADS);
      const promises = batch.map(async (file) => {
        const blobData = await createBlobWithRetry(file);
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blobData.sha,
        };
      });
      
      const batchResults = await Promise.all(promises);
      treeItems.push(...batchResults);
      
      currentStep += batch.length;
      onProgress(`Uploading files (${Math.min(currentStep, totalSteps - 2)}/${totalSteps - 2})...`, Math.min(currentStep, totalSteps - 2), totalSteps);
    }

    // 4. Create new tree
    onProgress("Creating project tree...", ++currentStep, totalSteps);
    const treeOptions: any = {
      owner,
      repo,
      tree: treeItems,
    };
    if (baseTreeSha) {
      treeOptions.base_tree = baseTreeSha;
    }
    const { data: newTree } = await octokit.rest.git.createTree(treeOptions);

    // 5. Create commit
    onProgress("Committing changes...", ++currentStep, totalSteps);
    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTree.sha,
      parents: commitSha ? [commitSha] : [],
    });

    // 6. Update reference
    onProgress("Finalizing...", ++currentStep, totalSteps);
    if (commitSha) {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: branchRef,
        sha: newCommit.sha,
      });
    } else {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/${branchRef}`,
        sha: newCommit.sha,
      });
    }
    
    return newCommit;
  } catch (error) {
    console.error("Error pushing to GitHub:", error);
    throw error;
  }
};
