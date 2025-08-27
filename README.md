# JSP到React转换服务

这是一个将JSP页面转换为React组件的服务，分为两个步骤：
1. JSP到JSON中间表示转换
2. JSON中间表示到React组件转换

## 项目结构

```
sample-agent-jsp-to-react/
├── server.js              # 主服务器入口
├── jsp-to-json/           # JSP到JSON转换模块
│   ├── index.js           # JSP到JSON服务路由
│   └── tools/             # JSP到JSON工具函数
├── json-to-react/         # JSON到React转换模块
│   ├── index.js           # JSON到React服务路由
│   └── tools/             # JSON到React工具函数
├── .env                   # 环境变量配置（需自行创建）
└── package.json           # 项目依赖
```

## 安装

1. 克隆仓库
2. 安装依赖
```bash
npm install
```
3. 复制环境变量示例文件并配置
```bash
cp .env.example .env
```
4. 编辑.env文件，填入你的OpenAI API密钥

## 使用方法

### 启动服务
```bash
npm start
```

### 开发模式（自动重启）
```bash
npm run dev
```

### API端点

1. JSP到JSON转换：
```
POST /api/jsp-to-json/chat
Content-Type: application/json

{
  "message": "你的JSP代码",
  "sessionId": "可选的会话ID"
}
```

2. JSON到React转换：
```
POST /api/json-to-react/generate-react
Content-Type: application/json

{
  "message": "你的JSON中间表示",
  "sessionId": "可选的会话ID"
}
```

## 注意事项

- 确保你有有效的OpenAI API密钥
- 默认服务端口为3000，可在.env文件中修改