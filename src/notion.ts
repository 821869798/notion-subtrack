import { Client } from "@notionhq/client";

export class NotionProcessor {

    static async resetRenewalStatus(notion: Client, databaseId: string): Promise<void> {

        var response;
        try {
            response = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    and: [
                        { property: "订阅状态", status: { equals: "手动订阅中" } },
                        { property: "需要提醒状态", checkbox: { equals: false } },
                        { property: "是否已续费", checkbox: { equals: true } }
                    ]
                }
            });
        } catch (error) {
            console.error("[resetRenewalStatus]Error querying database:", error);
            return;
        }

        if (response === undefined || response.results === undefined) {
            return;
        }

        console.log("need reset Renewal Count:", response.results.length);

        if (response.results.length == 0) {
            return;
        }
        // 创建一个Promise数组来存放所有的更新操作
        const updatePromises: Promise<void>[] = [];

        for (const page of response.results) {
            // 首先确保 page 是 PageObjectResponse 类型，而不是 PartialPageObjectResponse
            if (!('properties' in page)) {
                console.warn(`Page with ID ${page.id} is partial and lacks properties. Skipping.`);
                continue;
            }

            // 检查属性 "是否已续费" 是否存在且为 checkbox 类型
            const propertyToUpdate = page.properties["是否已续费"];
            if (propertyToUpdate && propertyToUpdate.type === 'checkbox') {
                // 将更新操作的Promise添加到数组中
                const updatePromise = notion.pages.update({
                    page_id: page.id,
                    properties: {
                        "是否已续费": {
                            checkbox: false
                        }
                    }
                }).then(() => {
                    console.log(`Successfully updated page ID: ${page.id}`);
                }).catch(updateError => {
                    // 单个页面更新失败，打印错误但允许其他页面继续尝试
                    console.error(`Failed to update page ID: ${page.id}`, updateError);
                });
                updatePromises.push(updatePromise);
            } else {
                console.warn(`Page ID: ${page.id}, "是否已续费" is not a checkbox property or does not exist, or page is not a full page object.`);
            }
        }

        // 等待所有更新操作完成
        try {
            await Promise.all(updatePromises);
            console.log("All page updates processed.");
        } catch (error) {
            // Promise.all 在这里实际上不会捕获到错误，因为我们已经在单个promise的 .catch 中处理了它们
            // 但如果单个promise没有 .catch，这里的 catch 会捕获第一个拒绝的promise的错误
            console.error("Error processing batch page updates (this shouldn't be reached if individual catches are in place):", error);
        }
    }

    static async remindSubRenew(notion: Client, databaseId: string, env: any): Promise<void> {
        var response;
        try {
            response = await notion.databases.query({
                database_id: databaseId,
                filter: {
                    and: [
                        { property: "订阅状态", status: { equals: "手动订阅中" } },
                        { property: "需要提醒状态", checkbox: { equals: true } },
                        { property: "是否已续费", checkbox: { equals: false } },
                    ]
                }
            });
        } catch (error) {
            console.error("[remindSubRenew]Error querying database:", error);
            return;
        }

        if (response === undefined || response.results === undefined) {
            return;
        }

        console.log("need remind Renewal Count:", response.results.length);

        if (response.results.length == 0) {
            return;
        }

        const pagesToRemindDetails: string[] = [];
        for (const page of response.results) {
            if (!('properties' in page)) {
                console.warn(`[remindSubRenew] Page with ID ${page.id} is partial. Skipping.`);
                continue;
            }

            let pageTitle = "【标题未获取】";
            const propertyTitle = page.properties["软件名称"];
            if (propertyTitle && propertyTitle.type === 'title' && Array.isArray(propertyTitle.title) && propertyTitle.title.length > 0) {
                pageTitle = propertyTitle.title[0].plain_text;
            }
            pagesToRemindDetails.push(`- ${pageTitle}`);
        }

        if (pagesToRemindDetails.length > 0) {
            const notificationTitle = "🔔 订阅续费提醒";
            const messageHeader = `您有 ${pagesToRemindDetails.length} 项订阅需要关注处理：\n`;
            const messageBody = pagesToRemindDetails.join("\n");
            const consolidatedMessage = `${messageHeader}\n${messageBody}`; // Telegram 和 ServerChan 的 desp 都可以用这个

            const channelNotificationPromises: Promise<void>[] = [];

            var telegramUrl = env.TELEGRAM_URL;
            var serverchanToken = env.SERVERCHAN_TOKEN;

            // trim string
            if (telegramUrl) {
                telegramUrl = telegramUrl.trim();
            }
            if (serverchanToken) {
                serverchanToken = serverchanToken.trim();
            }


            if (telegramUrl && telegramUrl.length > 0) {
                const telegramFullMessage = `${notificationTitle}\n${consolidatedMessage}`;
                channelNotificationPromises.push(
                    this.sendTelegramNotification(telegramFullMessage, telegramUrl)
                );
            }

            if (serverchanToken && serverchanToken.length > 0) {
                channelNotificationPromises.push(
                    this.sendServerChanNotification(notificationTitle, consolidatedMessage, serverchanToken)
                );
            }

            if (channelNotificationPromises.length > 0) {
                await Promise.all(channelNotificationPromises);
            }
        }
    }

    static async sendTelegramNotification(
        message: string,
        userProvidedUrl: string // 完整的 URL，例如: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
    ): Promise<void> {
        try {
            const urlObject = new URL(userProvidedUrl);
            // 基础URL应该是 .../sendMessage (不含查询参数)
            const baseUrlForPost = `${urlObject.protocol}//${urlObject.host}${urlObject.pathname}`;
            const chatIdFromQuery = urlObject.searchParams.get('chat_id');

            if (!chatIdFromQuery) {
                const errorMsg = "[Notification - Telegram] chat_id not found in the provided URL. Please ensure TELEGRAM_URL includes ?chat_id=xxxx";
                console.error(errorMsg);
                throw new Error(errorMsg);
            }

            const payload = {
                chat_id: chatIdFromQuery, // 从URL中提取的 chat_id
                text: message,
                parse_mode: "Markdown" // 或者 "HTML", 确保消息格式兼容
            };

            const response = await fetch(baseUrlForPost, { // POST到基础的 sendMessage 端点
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                // 打印返回
                response.json().then(responseBody => {
                    console.error(`[Notification - Telegram] Failed to send: ${response.status} ${response.statusText} - ${JSON.stringify(responseBody)}`);
                });
                return;
            }
            console.log("[Notification - Telegram] Consolidated message sent successfully.");
        } catch (error) {
            // 确保错误被记录，即使 fetch 本身抛出（如网络问题）或 URL 解析失败
            if (error instanceof Error) {
                // 避免重复记录已知类型的错误
                if (!error.message.includes("Telegram API error") && !error.message.includes("chat_id not found")) {
                    console.error("[Notification - Telegram] Error sending notification:", error.message);
                }
            } else {
                console.error("[Notification - Telegram] An unknown error occurred:", error);
            }
        }
    }

    static async sendServerChanNotification(
        title: string,
        desp: string, // description/body
        token: string
    ): Promise<void> {
        const serverchanUrl = `https://sctapi.ftqq.com/${token}.send`;
        const formData = new URLSearchParams();
        formData.append('title', title.substring(0, 100)); // ServerChan 标题有长度限制
        formData.append('desp', desp);

        try {
            const response = await fetch(serverchanUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData,
            });
            const responseBody = await response.json().catch(() => ({ code: -1, message: "Failed to parse JSON response" }));

            if (!response.ok) { // HTTP error
                response.json().then(responseBody => {
                    console.error(`[Notification - ServerChan] Failed to send: ${response.status} ${response.statusText} - ${JSON.stringify(responseBody)}`);
                });
                return;
            }

            console.log("[Notification - ServerChan] Consolidated message sent successfully.");
        } catch (error) {
            if (!(error instanceof Error && (error.message.includes("ServerChan API HTTP error") || error.message.includes("ServerChan notification indicated failure")))) {
                console.error("[Notification - ServerChan] Network or other error:", error);
            }
        }
    }
}