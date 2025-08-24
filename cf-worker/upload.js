// filename: cf-worker/upload.js
/**
 * Cloudflare Worker 处理 /api/upload
 *
 * 功能：
 * 1. 接收前端 JSON：{ title, desc, icon, fileName, fileContent }
 * 2. 调 GitHub REST API   ->  新建 blob + 更新 tree
 * 3. 提交到 ai-toolbox/main
 *
 * 环境变量 (在 Workers Dashboard → Settings → Variables)：
 * - GITHUB_TOKEN   : GitHub PAT，需 repo 权限
 * - GITHUB_REPO    : e.g. "fendaabc/ai-toolbox"
 * - GITHUB_BRANCH  : e.g. "main"
 * - ONLINE_SECTION_MARKER : 固定锚点，index.html 里需要有 <!-- ONLINE_TOOLS_START --> 与 <!-- ONLINE_TOOLS_END -->
 */
export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    /** @type {{title:string,desc:string,icon:string,fileName:string,fileContent:string}} */
    const { title, desc, icon, fileName, fileContent } = await req.json();

    if (!title || !fileName || !fileContent) {
      return new Response('缺少必要字段', { status: 400 });
    }

    // ---- GitHub REST helpers ----
    const api = async (url, init = {}) => {
      init.headers = {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        ...init.headers
      };
      return fetch(`https://api.github.com${url}`, init).then(r => r.json());
    };

    const [owner, repo] = env.GITHUB_REPO.split('/');
    // 1️⃣ 获取 main 最新 commit & tree
    const ref = await api(`/repos/${owner}/${repo}/git/refs/heads/${env.GITHUB_BRANCH}`);
    const latestCommitSha = ref.object.sha;
    const baseCommit = await api(`/repos/${owner}/${repo}/git/commits/${latestCommitSha}`);

    // 2️⃣ 创建新文件 blob
    const newFileBlob = await api(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: btoa(unescape(encodeURIComponent(fileContent))), // base64
        encoding: 'base64'
      })
    });

    // 3️⃣ 获取并修改 index.html
    const indexBlobSha = baseCommit.tree.tree.find(t => t.path === 'index.html').sha;
    const indexBlob = await api(`/repos/${owner}/${repo}/git/blobs/${indexBlobSha}`)
    const indexContent = decodeURIComponent(escape(atob(indexBlob.content)));
    const updatedIndex = insertCard(indexContent, { title, desc, icon, fileName });

    const newIndexBlob = await api(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: btoa(unescape(encodeURIComponent(updatedIndex))),
        encoding: 'base64'
      })
    });

    // 4️⃣ 创建新 tree
    const newTree = await api(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [
          { path: fileName, mode: '100644', type: 'blob', sha: newFileBlob.sha },
          { path: 'index.html', mode: '100644', type: 'blob', sha: newIndexBlob.sha }
        ]
      })
    });

    // 5️⃣ 创建 commit
    const newCommit = await api(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `feat: add tool ${title}`,
        tree: newTree.sha,
        parents: [latestCommitSha]
      })
    });

    // 6️⃣ 更新 ref
    await api(`/repos/${owner}/${repo}/git/refs/heads/${env.GITHUB_BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha })
    });

    return new Response('OK');
  }
}

/**
 * 将新卡片插入 index.html 的 ONLINE_TOOLS 分区
 * @param {string} html
 * @param {{title:string,desc:string,icon:string,fileName:string}} info
 * @returns {string}
 */
function insertCard(html, info) {
  const cardTpl = `
        <article class="card">
          <div class="card-title">${info.icon} ${info.title}</div>
          <p class="card-desc">${info.desc}</p>
          <a class="card-link" href="${info.fileName}" target="_blank">在线打开</a>
        </article>`;
  const startTag = '<!-- ONLINE_TOOLS_START -->';
  const endTag   = '<!-- ONLINE_TOOLS_END -->';
  const startIdx = html.indexOf(startTag);
  const endIdx   = html.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) throw new Error('未找到锚点');

  // 注：插入到 START 和 END 之间的末尾
  return html.slice(0, endIdx) + cardTpl + '\n' + html.slice(endIdx);
}
