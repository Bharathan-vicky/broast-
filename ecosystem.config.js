module.exports = {
  apps: [
    {
      name: 'broast-backend',
      script: 'backend/server.py',
      interpreter: '.venv/Scripts/pythonw.exe',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 30,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      merge_logs: true,
      windowsHide: true,
      env: {
        PYTHONUNBUFFERED: '1',
        PORT: '8000'
      }
    }
  ]
};
