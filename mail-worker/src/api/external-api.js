import app from '../hono/hono';
import result from '../model/result';
import externalService from '../service/external-service';

app.post('/public/sendEmail', async (c) => {
	const data = await externalService.sendEmail(c, await c.req.json());
	return c.json(result.ok(data));
});
