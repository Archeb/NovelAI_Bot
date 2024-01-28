const { Telegraf, Markup } = require("telegraf");
var yauzl = require("yauzl");
const superagent = require("superagent");
const queue = require("promise-queue-plus");
const fs = require("fs");
const events = require("events");
const concatstream = require("concat-stream");

const endpoint = "https://api.novelai.net/ai/generate-image";
const defaultUC =
	"{bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad proportions";
const defaultQT = "best quality, amazing quality, very aesthetic, absurdres";
const bot = new Telegraf(process.env.BOT_TOKEN);

const userSettings = require("./config/userSettings.json");
const { env } = require("process");
const userLatestSettings = {};
const userLatestRaw = {};
const apiQueue = queue(1, {
	retry: 0,
	retryIsJump: false,
	timeout: 0,
	workFinally: workFinally,
});
const workFinEmitter = new events.EventEmitter();

bot.use(async (ctx, next) => {
	if (!userSettings[ctx.from.id] && !(ctx.message?.text == "/start" || ctx.message?.text.substring(0, 7) == "/enable" || ctx.message?.text == "/help")) {
		ctx.reply("You are not authorized.").catch((err) => {
			console.error(err);
		});
		return;
	} else {
		next();
	}
});

bot.start((ctx) => ctx.reply("This is a private bot. Use /help command to get help, click the menu button to see all available commands."));
bot.help((ctx) =>
	ctx.reply(
		`You need a passcode to unlock all the features.
text2img: type prompts in the chatbox and send to me.`
	)
);

bot.command("setsize", (ctx) => {
	arguments = ctx.message.text.substring(9);
	if (arguments != "") {
		arguments = arguments.split(" ");
		if (arguments.length == 2) {
			// parse arguments
			let width = parseInt(arguments[0]);
			let height = parseInt(arguments[1]);
			// if width and height can be divided by 64
			if (width % 64 == 0 && height % 64 == 0) {
				if (width * height <= 1048576) {
					userSettings[ctx.from.id].width = width;
					userSettings[ctx.from.id].height = height;
					ctx.reply(`设置成功，宽度为${width}，高度为${height}`);
				} else {
					ctx.reply("图片尺寸过大，总像素不能超过1048576px");
				}
			} else {
				ctx.reply("边长需为64的倍数");
			}
		} else {
			ctx.reply("参数错误");
		}
	} else {
		ctx.reply("请选择你需要的图片尺寸，或者使用 `/setsize <width> <height>` 来自定义尺寸 \n总像素不能超过983040px (1280x768)，且边长需为64的倍数", {
			...Markup.inlineKeyboard([
				[Markup.button.callback("↕️ Portrait (纵向 832x1216)", "setSizePortrait")],
				[Markup.button.callback("↔️ Landscape (横向 1216x832)", "setSizeLandscape")],
				[Markup.button.callback("⬜ Square (方形 1024x1024)", "setSizeSquare")],
			]),
			parse_mode: "Markdown",
		});
	}
});

bot.command("setsampler", (ctx) => {
	ctx.reply(
		"请选择你需要的Sampler",
		Markup.inlineKeyboard([
			[Markup.button.callback("Euler Ancestral", "setsampler1"), Markup.button.callback("Euler", "setsampler2")],
			[Markup.button.callback("DPM++ 2S Ancestral", "setsampler3"), Markup.button.callback("DPM++ SDE", "setsampler4")],
		])
	);
});

bot.command("advancedgenerate", (ctx) => {
	arguments = ctx.message.text.substring(18);
	if (arguments != "") {
		try {
			arguments = JSON.parse(arguments);
			if (arguments.width * arguments.height > 983040) {
				ctx.reply("图片尺寸过大，总像素不能超过983040px");
				return;
			}
			if (parseInt(arguments.steps) > 50) {
				ctx.reply("步数过大，最大为 50");
				return;
			}
			ProcessUserRequest(ctx, arguments);
		} catch (e) {
			ctx.reply("参数错误：`" + e + "`", { parse_mode: "Markdown" });
			return;
		}
	} else {
		ctx.reply(
			`使用 \`/advancedgenerate <JSON>\` 来指定生成参数，未指定的参数会被用户设置和默认设置覆盖。
支持的参数和默认值如下：
\`\`\`
{
	prompt,
	seed = Math.floor(Math.random() * 2 ** 32),
	width = 832,
	height = 1216,
	sampler = "k_dpmpp_2s_ancestral",
	scale = 5,
	negative_prompt = uc,
	steps = 28,
}
\`\`\``,
			{
				parse_mode: "Markdown",
			}
		);
		return;
	}
});

bot.command("editparameter", async (ctx) => {
	arguments = ctx.message.text.substring(15);

	if (arguments != "") {
		if (!userLatestSettings[ctx.from.id]) {
			ctx.reply("您还没有生成过图片");
			return;
		}
		try {
			arguments = JSON.parse(arguments);
			if (arguments.width * arguments.height > 983040) {
				ctx.reply("图片尺寸过大，总像素不能超过983040px");
				return;
			}
			if (parseInt(arguments.steps) > 50) {
				ctx.reply("步数过大，最大为 50");
				return;
			}
			ProcessUserRequest(ctx, { ...userLatestSettings[ctx.from.id], ...arguments });
		} catch (e) {
			ctx.reply("参数错误：`" + e + "`", { parse_mode: "Markdown" });
			return;
		}
	} else {
		ctx.reply(
			`使用 \`/editparameter <JSON>\` 来编辑上一张图的参数（保留seed）并重新生成，未指定的参数会被上一次的参数和用户参数覆盖。
该方法支持的参数和默认值请参考 \`/advancedgenerate\` 命令。`,
			{
				parse_mode: "Markdown",
			}
		);
		return;
	}
});

bot.command("enable", (ctx) => {
	arguments = ctx.message.text.substring(8);
	if (arguments == process.env.PASSWORD && !userSettings[ctx.from.id]) {
		userSettings[ctx.from.id] = {};
		saveAllUserSettings();
		ctx.reply("Authorized");
	} else {
		ctx.reply("Already authorized / Wrong Passcode");
	}
});

bot.command("deauth", (ctx) => {
	if (userSettings[ctx.from.id]) {
		delete userSettings[ctx.from.id];
		saveAllUserSettings();
		ctx.reply("Deauthorized");
	}
});

bot.command("setuc", (ctx) => {
	arguments = ctx.message.text.substring(7);
	if (arguments != "") {
		userSettings[ctx.from.id].uc = arguments;
		saveAllUserSettings();
		ctx.reply("negative prompt 已设置");
	} else {
		ctx.reply("请在命令后输入 negative prompt \n默认为：`" + defaultUC + "`", { parse_mode: "Markdown" });
	}
});

bot.command("setqt", (ctx) => {
	arguments = ctx.message.text.substring(7);
	if (arguments != "") {
		userSettings[ctx.from.id].qt = arguments;
		saveAllUserSettings();
		ctx.reply("Quality Tags 已设置");
	} else {
		ctx.reply("请在命令后输入 Quality Tags \n默认为：`" + defaultQT + "`", { parse_mode: "Markdown" });
	}
});

bot.command("setsteps", (ctx) => {
	arguments = ctx.message.text.substring(10);
	if (arguments != "") {
		if (parseInt(arguments) > 0 && parseInt(arguments) < 51) {
			userSettings[ctx.from.id].steps = parseInt(arguments);
			saveAllUserSettings();
			ctx.reply("已设置步数为 *" + userSettings[ctx.from.id].steps + "*", { parse_mode: "Markdown" });
		} else {
			ctx.reply("输入不符合要求，最大步数 *60* 步", { parse_mode: "Markdown" });
		}
	} else {
		ctx.reply("请在命令后设置步数\n默认步数为 *28* 步，计算速度约为 4.2 steps/s", { parse_mode: "Markdown" });
	}
});

bot.command("setscale", (ctx) => {
	arguments = ctx.message.text.substring(10);
	if (arguments != "") {
		if (parseInt(arguments) >= 0 && parseInt(arguments) < 51) {
			userSettings[ctx.from.id].scale = parseInt(arguments);
			saveAllUserSettings();
			ctx.reply("已设置scale为 *" + userSettings[ctx.from.id].scale + "*", { parse_mode: "Markdown" });
		} else {
			ctx.reply("输入不符合要求，0 ≤ scale ≤ 50", { parse_mode: "Markdown" });
		}
	} else {
		ctx.reply("请在命令后设置scale (freedom)，，0 ≤ scale ≤ 50", { parse_mode: "Markdown" });
	}
});

bot.command("getstatus", (ctx) => {
	ctx.reply("当前有 " + apiQueue.getLength() + " 个任务\n您当前的个人设置为 `" + JSON.stringify(userSettings[ctx.from.id]) + "`", { parse_mode: "Markdown" });
});

bot.on("text", async (ctx) => {
	ProcessUserRequest(ctx, { prompt: ctx.message.text });
});

bot.on("callback_query", async (ctx) => {
	switch (ctx.callbackQuery.data.split(" ")[0]) {
		case "getRaw":
			if(userLatestRaw[ctx.callbackQuery.data.split(" ")[1]]) {
				// send raw as image file
				await ctx.answerCbQuery("正在发送原图");
				await ctx.sendDocument({ 
					filename: "image.png",
					source: userLatestRaw[ctx.callbackQuery.data.split(" ")[1]] 
				});
			}else{
				await ctx.answerCbQuery("图片已过期，请重新生成");
				return;
			}
			break;
		case "repeatSample":
			if (userLatestSettings[ctx.from.id]) {
				await ctx.answerCbQuery("已提交请求");
				ProcessUserRequest(ctx, userLatestSettings[ctx.from.id], true);
			} else {
				await ctx.answerCbQuery("您还没有生成过图片");
			}
			break;
		case "increaseSteps":
			await ctx.answerCbQuery("如需更多步数，请前往网页版使用");
			return
			break;
		case "decreaseSteps":
			if (userLatestSettings[ctx.from.id]) {
				// 如果没有手动设置，则取用户默认设置
				if (!userLatestSettings[ctx.from.id].steps) userLatestSettings[ctx.from.id].steps = userSettings[ctx.from.id].steps;
				// 如果还是没有，就用默认值
				if (!userLatestSettings[ctx.from.id].steps) userLatestSettings[ctx.from.id].steps = 28;
				if (userLatestSettings[ctx.from.id].steps > 1) {
					userLatestSettings[ctx.from.id].steps -= 10;
					if (userLatestSettings[ctx.from.id].steps < 1) userLatestSettings[ctx.from.id].steps = 1;
					await ctx.answerCbQuery("已减少10步，当前步数为" + userLatestSettings[ctx.from.id].steps);
					ProcessUserRequest(ctx, { ...userLatestSettings[ctx.from.id] });
				} else {
					await ctx.answerCbQuery("已达到最小步数");
				}
			} else {
				await ctx.answerCbQuery("您还没有生成过图片");
			}
			break;
		case "setSizeSquare":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].width = 1024;
				userSettings[ctx.from.id].height = 1024;
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置图片尺寸为 Square");
			}
			break;
		case "setSizeLandscape":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].width = 1216;
				userSettings[ctx.from.id].height = 832;
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置图片尺寸为 Landscape");
			}
			break;
		case "setSizePortrait":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].width = 832;
				userSettings[ctx.from.id].height = 1216;
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置图片尺寸为 Portrait");
			}
			break;
		case "setsampler1":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].sampler = "k_euler_ancestral";
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置Sampler为 k_euler_ancestral");
			}
			break;
		case "setsampler2":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].sampler = "k_euler";
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置Sampler为 k_euler");
			}
			break;
		case "setsampler3":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].sampler = "k_dpmpp_2s_ancestral";
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置Sampler为 DPM++ 2S Ancestral");
			}
			break;
		case "setsampler4":
			if (userSettings[ctx.from.id]) {
				userSettings[ctx.from.id].sampler = "k_dpmpp_sde";
				saveAllUserSettings();
				await ctx.answerCbQuery("已设置Sampler为 DPM++ SDE");
			}
			break;
		default:
			await ctx.answerCbQuery("未知的操作");
			break;
	}
});

bot.launch();

async function ProcessUserRequest(ctx, temporarySettings = {}, newSeed = false) {
	let taskIndex = apiQueue.getLength() + 1;
	let tipMsgId = (await ctx.reply("正在生成中...")).message_id;

	let updateQueueLength = () => {
		taskIndex--;
		if (taskIndex < 1) {
			messageContent = "正在生成中... 正在处理您的任务";
		} else {
			messageContent = "正在生成中... 前方有" + taskIndex + "个任务";
		}
		bot.telegram.editMessageText(ctx.chat.id, tipMsgId, undefined, messageContent).catch((err) => {
			console.error(err);
		});
	};
	workFinEmitter.on("workFinally", updateQueueLength);

	temporarySettings.seed = temporarySettings.seed && newSeed == false ? temporarySettings.seed : Math.floor(Math.random() * 2 ** 32);

	userLatestSettings[ctx.from.id] = temporarySettings;

	apiQueue
		.go(RequestAPI, [{ ...userSettings[ctx.from.id], ...temporarySettings }])
		.then(async (apiRet) => {
			const genID = Math.floor(Math.random() * 2 ** 32);
			// 如果userLatestRaw 超过 500 张，就删除第一张
			if (Object.keys(userLatestRaw).length > 500) {
				delete userLatestRaw[Object.keys(userLatestRaw)[0]];
			}
			userLatestRaw[genID] = apiRet.img;
			await bot.telegram.editMessageText(ctx.chat.id, tipMsgId, undefined, "正在上传中……");
			await ctx.replyWithPhoto(
				{ source: apiRet.img },
				{
					caption: `Seed: \`${apiRet.settings.parameters.seed}\`
Scale: \`${apiRet.settings.parameters.scale}\`
Sampler: \`${apiRet.settings.parameters.sampler}\`
Prompt: \`${apiRet.settings.input.length < 990 ? apiRet.settings.input : "太长了，自己反思一下"}\``,
					parse_mode: "Markdown",
					reply_to_message_id: ctx.message?.message_id ?? undefined,
					...Markup.inlineKeyboard([
						[Markup.button.callback("🔁 再来一张", "repeatSample")],
						[Markup.button.callback("⬇️ 获取原图", `getRaw ${genID}`)],
					]),
				}
			);
		})
		.catch((err) => {
			if (err.length < 500) {
				ctx.reply("出现错误：`" + err + "`", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔁 重试", "repeatSample")]])});
			}else{
				ctx.reply("出现错误：`" + err.substring(0, 500) + "`", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔁 重试", "repeatSample")]])});
			}
			console.error(err);
		})
		.finally(() => {
			workFinEmitter.removeListener("workFinally", updateQueueLength);
			ctx.deleteMessage(tipMsgId).catch((err) => {
				console.error(err);
			});
		});
}

function RequestAPI({
	image = undefined,
	prompt,
	seed,
	width = 832,
	height = 1216,
	sampler = "k_dpmpp_2s_ancestral",
	scale = 5,
	qt = defaultQT,
	uc = defaultUC,
	steps = 28,
}) {
	return new Promise((resolve, reject) => {
		let finalSettings = {
			"input": prompt + "," + qt,
			"model": "nai-diffusion-3",
			"action": "generate",
			"parameters": {
				add_original_image: false,
				cfg_rescale: 0,
				controlnet_strength: 1,
				dynamic_thresholding: false,
				height,
				legacy: false,
				legacy_v3_extend: false,
				n_samples: 1,
				negative_prompt: uc,
				noise_schedule: "native",
				params_version: 1,
				qualityToggle: true,
				sampler,
				scale,
				seed,
				sm: false,
				sm_dyn: false,
				steps,
				ucPreset: 0,
				uncond_scale: 1,
				width
			}
		};
		console.log(finalSettings);
		superagent
			.post(endpoint)
			.set("Authorization", `Bearer ${process.env.NAI_TOKEN}`)
			.send(finalSettings)
			.end((err, res) => {
				if (err) {
					if(err.status == 429) {
						reject("API请求频率过高，请稍后再试");
					}else{
						reject(JSON.stringify(err));
					}
					
				} else {
					// use yauzl to unzip res.body and get the file /image_0.png
					yauzl.fromBuffer(res.body, { lazyEntries: true }, (err, zipfile) => {
						if (err) {
							reject(JSON.stringify(err));
						} else {
							zipfile.readEntry();
							zipfile.on("entry", (entry) => {
								if (/image_0\.png$/.test(entry.fileName)) {
									zipfile.openReadStream(entry, (err, readStream) => {
										if (err) {
											reject(JSON.stringify(err));
										} else {
											readStream.pipe(concatstream((imgBuffer) => {
												resolve({
													img: imgBuffer,
													settings: finalSettings
												});
											}));
										}
									});
								} else {
									zipfile.readEntry();
								}
							});
						}
					});
					
				}
			});
	});
}

function workFinally() {
	workFinEmitter.emit("workFinally");
}

function saveAllUserSettings() {
	fs.writeFileSync("./config/userSettings.json", JSON.stringify(userSettings));
}

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
