n# Delta Exchange Options Trading Simulator

This project is a lightning-fast, zero-lag options trading simulator supporting both NIFTY/BANKNIFTY (NSE) and Crypto (BTC/ETH/XAUT). It features a robust Python backend with a pre-warmed in-memory engine, a React-based web terminal, and a React Native Expo mobile app.

## Project Structure

- **Backend (`/`)**: FastAPI Python server (`server.py`) handling live spot syncing, synthetic option chains, P&L calculations, and SQLite trade journaling.
- **Web Frontend (`/frontend`)**: React + Vite web terminal application.
- **Mobile App (`/mobile`)**: React Native + Expo application built for a flawless mobile experience.

---

## How to Start Locally

To run the full stack, you need to open three separate terminal windows/tabs and start each component individually.

### 1. Start the Backend Server

The backend requires Python and serves as the data engine for both Web and Mobile.

1. Open a new terminal in the root directory (`c:\web_project\delta`).
2..venv\Scripts\activate Activate your virtual environment (if you are using one, e.g., `` on Windows).
3. Run the server using:
   ```bash
   python server.py
   ```
*(The server will start on `http://127.0.0.1:8000` or `http://localhost:8000`)*

### 2. Start the Web Frontend (Vite + React)

1. Open a second terminal window and navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Install dependencies (if you haven't already):
   ```bash
   npm install
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
*(The web app will be available at the local URL provided by Vite, typically `http://localhost:5173`)*

### 3. Start the Mobile App (Expo + React Native)

1. Open a third terminal window and navigate to the mobile directory:
   ```bash
   cd mobile
   ``
2. Install dependencies (if you haven't already):
   ```bash
   npm install
   ```
3. Start the Expo metro bundler:
   ```bash
   npx expo start
   ```
*(Scan the QR code displayed in the terminal with the Expo Go app on your physical device, or press `a` for Android Emulator / `i` for iOS Simulator)*

---

## Important Notes for Mobile Testing
- The mobile app is configured to fetch data from the backend. By default, Expo points to your local machine's IP (e.g., `http://192.168.x.x:8000`). 
- Make sure your physical mobile device and your computer are connected to the **same Wi-Fi network**.
- This setup ensures direct IPv4 routing for sub-millisecond lag-free trading execution.
# 1. Activate the virtual environment
.venv\Scripts\activate

# 2. Run the server script inside the backend folder
python backend/server.py
