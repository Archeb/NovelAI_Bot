# NovelAI Telegram Bot

这个 Bot 可以把你的 NovelAI 画图接入 Telegram API

需要指定 `PASSWORD`（启用密码）、`BOT_TOKEN`（Telegram Bot 的 Token） 和 `NAI_TOKEN`（NovelAI 的 Token） 环境变量

并且创建 `config/userSettings.json` 文件

然后私聊机器人，输入 `/enable 密码` 即可启用权限，然后直接发送 prompt 即可开始生成。

更多功能请查看 `/help`