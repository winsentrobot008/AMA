import time
import json
import os
from pathlib import Path

import requests

CONFIG_PATH = "config.json"
STATE_PATH = "state.json"


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    if not os.path.exists(STATE_PATH):
        return {"processed_issues": []}
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def fetch_labeled_issues(token, repo, label):
    url = f"https://api.github.com/repos/{repo}/issues"
    params = {"state": "open", "labels": label}
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }
    resp = requests.get(url, headers=headers, params=params)
    resp.raise_for_status()
    return resp.json()


def ensure_tasks_dir(path):
    Path(path).mkdir(parents=True, exist_ok=True)


def create_task_file(tasks_dir, issue):
    issue_id = issue["number"]
    title = issue["title"]
    body = issue.get("body") or ""
    filename = Path(tasks_dir) / f"issue-{issue_id}.md"

    content = f"""# GitHub Issue #{issue_id}: {title}

原始 Issue 链接：{issue['html_url']}

---

## 任务说明（来自 Issue）

{body}

---

## 给 CLINE 的建议提示（复制到 VSCode 的 CLINE 输入框）

请根据上面的 Issue 内容执行以下步骤：
1. 理解需求并补充必要假设；
2. 规划实现步骤；
3. 修改/新增代码文件；
4. 运行必要测试；
5. 准备提交 PR 的变更说明。
"""

    with open(filename, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"[+] 生成任务文件: {filename}")


def comment_issue(token, repo, issue_number, comment):
    url = f"https://api.github.com/repos/{repo}/issues/{issue_number}/comments"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }
    data = {"body": comment}
    resp = requests.post(url, headers=headers, json=data)
    resp.raise_for_status()
    print(f"[+] 已回写 Issue #{issue_number} 评论：{comment}")


def update_issue_status(token, repo, issue_number):
    comment_issue(
        token,
        repo,
        issue_number,
        "👷 AMA 已接收任务，状态：**执行中**",
    )


def main():
    config = load_config()
    state = load_state()

    token = config["github_token"]
    repo = config["repo"]
    label = config["label"]
    interval = config.get("poll_interval_seconds", 20)
    tasks_dir = config.get("tasks_dir", "tasks")

    ensure_tasks_dir(tasks_dir)

    print(f"🚀 AMA 已启动，监听仓库 {repo} 中带标签 '{label}' 的 Issue...")
    while True:
        try:
            issues = fetch_labeled_issues(token, repo, label)
            for issue in issues:
                issue_id = issue["number"]
                if issue_id in state["processed_issues"]:
                    continue

                print(f"[!] 发现新任务 Issue #{issue_id}: {issue['title']}")
                create_task_file(tasks_dir, issue)
                update_issue_status(token, repo, issue_id)
                state["processed_issues"].append(issue_id)
                save_state(state)

        except Exception as e:
            print(f"[错误] 轮询时发生异常: {e}")

        time.sleep(interval)


if __name__ == "__main__":
    main()
