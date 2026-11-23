# WebDAV Versions 0.4.0 正式版

本正式版基于 `0.4.0-beta.5`。两版的插件程序 `main.js` 完全相同。已安装 beta.5 的用户可直接更新到 `0.4.0`，沿用原有笔记、设置和同步记录。

- Mac 与 iPhone 各自使用本地 Obsidian 库，通过 HTTPS WebDAV 同步笔记和附件，保留并发编辑产生的冲突副本。
- 电脑完成同步删除后，会尝试清理因此变空的父目录。手机和历史残留的空目录可在「查看同步冲突 → 空文件夹」中逐项确认。使用回收站清理时，最后一次检查后新写入的文件也可能进入回收站，可从回收站恢复。
- 安装要求 Obsidian 1.11.4 或更高版本。在 BRAT 中选择固定版本 `0.4.0`；手动升级时只覆盖 `main.js` 和 `manifest.json`，保留已有的 `data.json` 和 `local-state/`。
- NAS 无头同步端和 Docker 镜像继续由 [0.4.0-beta.6 预发布版](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/releases/tag/0.4.0-beta.6) 提供。

本次转正沿用 beta.5 的自动化验收范围；未新增 Mac 或 iPhone 真机清理验收。[空文件夹行为与验收记录](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/blob/0.4.0/docs/空文件夹清理.md)
