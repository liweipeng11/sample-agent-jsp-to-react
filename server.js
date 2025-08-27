import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 导入子模块路由
import jspToJsonRouter from './jsp-to-json/index.js';
import jsonToReactRouter from './json-to-react/index.js';

// 配置环境变量
dotenv.config();

// 初始化 Express 应用
const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 中间件
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 路由配置
app.get('/', (req, res) => {
  res.send('JSP 到 React 转换服务已启动');
});

// 将子模块的路由挂载到主应用
// 注意：这里我们不直接使用子模块的app实例，而是导出它们的路由
app.use('/api/jsp-to-json', jspToJsonRouter);
app.use('/api/json-to-react', jsonToReactRouter);

// 启动服务器
app.listen(port, () => {
  console.log(`主服务器已启动，监听端口 ${port}`);
  console.log(`JSP到JSON服务: http://localhost:${port}/api/jsp-to-json/chat`);
  console.log(`JSON到React服务: http://localhost:${port}/api/json-to-react/generate-react`);
});

process.on('SIGINT', () => {
  console.log('正在关闭服务器...');
  process.exit(0);
});