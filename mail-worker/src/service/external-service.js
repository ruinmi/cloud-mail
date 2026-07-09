import orm from '../entity/orm';
import email from '../entity/email';
import { emailConst, settingConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import settingService from './setting-service';
import accountService from './account-service';
import userService from './user-service';
import emailService from './email-service';
import attService from './att-service';
import kvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { t } from '../i18n/i18n';

const externalService = {

	resolveDomainList(c) {
		let domainEnv = c.env.domain;

		if (typeof domainEnv === 'string') {
			try {
				domainEnv = JSON.parse(domainEnv);
			} catch (e) {
				domainEnv = domainEnv.split(',').map(item => item.trim());
			}
		}

		return Array.isArray(domainEnv) ? domainEnv.filter(Boolean) : [];
	},

	normalizeRecipients(to) {
		if (typeof to === 'string') {
			return to.split(',').map(item => item.trim()).filter(Boolean);
		}

		if (Array.isArray(to)) {
			return to.map(item => `${item || ''}`.trim()).filter(Boolean);
		}

		return [];
	},

	async sendEmail(c, params = {}) {
		let { from, fromName, to, subject, text, html, attachments } = params;
		attachments = Array.isArray(attachments) ? attachments : [];

		this.validateRequest(c, { from, to, subject, text, html, attachments });

		const fromDomain = emailUtils.getDomain(from);
		const receiveEmail = this.normalizeRecipients(to);
		const { resendTokens, send, domainList: internalDomainList } = await settingService.query(c);

		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		const allInternal = receiveEmail.every(address => {
			return internalDomainList.includes('@' + emailUtils.getDomain(address));
		});
		const resendToken = resendTokens[fromDomain];
		const useCloudflareEmail = Boolean(c.env.email);

		if (!allInternal && !useCloudflareEmail && !resendToken) {
			throw new BizError(t('noSendProvider'), 400);
		}

		const name = fromName || emailUtils.getName(from);
		let providerResult = {};

		if (!allInternal) {
			const sendParams = {
				name,
				accountEmail: from,
				receiveEmail,
				subject,
				text: text || '',
				html: html || '',
				attachments,
				sendType: 'external',
				messageId: null
			};

			providerResult = useCloudflareEmail
				? await emailService.sendByCloudflareEmail(c, sendParams)
				: await emailService.sendByResend(resendToken, sendParams);
		}

		const { data, error } = providerResult;
		if (error) {
			throw new BizError(error.message || String(error));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, from);
		const adminUser = await userService.selectByEmail(c, c.env.admin);
		const userId = accountRow?.userId || adminUser?.userId || 0;
		const accountId = accountRow?.accountId || 0;
		const recipient = receiveEmail.map(address => ({ address, name: '' }));
		const emailData = {
			sendEmail: from,
			name,
			subject,
			content: html || '',
			text: text || '',
			accountId,
			userId,
			status: useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT,
			type: emailConst.type.SEND,
			resendEmailId: data?.id || null,
			recipient: JSON.stringify(recipient)
		};

		const emailResult = await orm(c).insert(email).values(emailData).returning().get();

		if (attachments.length > 0) {
			await attService.saveSendAtt(c, attachments, userId, accountId, emailResult.emailId);
		}

		const attList = await attService.selectByEmailIds(c, [emailResult.emailId]);
		emailResult.attList = attList;

		if (allInternal) {
			await emailService.HandleOnSiteEmail(c, receiveEmail, emailResult, attList);
		}

		await this.increaseDailySendCount(c, receiveEmail.length);

		return {
			emailId: emailResult.emailId,
			messageId: data?.id || null,
			channel: allInternal ? 'internal' : (useCloudflareEmail ? 'cloudflare' : 'resend'),
			status: allInternal || useCloudflareEmail ? 'delivered' : 'sent',
			from,
			to: receiveEmail,
			createTime: emailResult.createTime
		};
	},

	validateRequest(c, { from, to, subject, text, html, attachments }) {
		if (!from || !verifyUtils.isEmail(from)) {
			throw new BizError(t('externalFromInvalid'), 400);
		}

		const domainList = this.resolveDomainList(c);
		if (!domainList.includes(emailUtils.getDomain(from))) {
			throw new BizError(t('externalFromDomainInvalid'), 400);
		}

		const receiveEmail = this.normalizeRecipients(to);
		if (receiveEmail.length === 0) {
			throw new BizError(t('externalToRequired'), 400);
		}

		for (const address of receiveEmail) {
			if (!verifyUtils.isEmail(address)) {
				throw new BizError(t('notEmail'), 400);
			}
		}

		if (!subject) {
			throw new BizError(t('externalSubjectRequired'), 400);
		}

		if (!text && !html) {
			throw new BizError(t('externalContentRequired'), 400);
		}

		if (attachments.length > 10) {
			throw new BizError(t('attLimit'), 400);
		}
	},

	async increaseDailySendCount(c, quantity) {
		const dateStr = dayjs().format('YYYY-MM-DD');
		const key = kvConst.SEND_DAY_COUNT + dateStr;
		const daySendTotal = Number(await c.env.kv.get(key) || 0) + quantity;
		await c.env.kv.put(key, JSON.stringify(daySendTotal), { expirationTtl: 60 * 60 * 24 });
	}

};

export default externalService;
