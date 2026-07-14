#!/bin/bash

# SECURECAM v3 - Complete Setup Script
# This script helps you set up both server and app

echo "🎥 SECURECAM v3 - Setup Script"
echo "================================"
echo ""

# Check if we're in the right directory
if [ ! -f "server.py" ]; then
    echo "❌ Error: server.py not found!"
    echo "Please run this script from the project root directory."
    exit 1
fi

echo "✅ Found server.py"
echo ""

# Ask user what they want to set up
echo "What do you want to set up?"
echo "1) Bot Server (Koyeb/Local)"
echo "2) Android App"
echo "3) Both"
echo ""

read -p "Enter choice (1-3): " choice

case $choice in
    1)
        echo ""
        echo "🤖 Setting up Bot Server..."
        echo ""
        
        # Check Python
        if ! command -v python3 &> /dev/null; then
            echo "❌ Python 3 not found! Please install Python 3.8+"
            exit 1
        fi
        echo "✅ Python 3 found"
        
        # Install requirements
        echo "📦 Installing requirements..."
        pip3 install -r requirements.txt
        
        if [ $? -ne 0 ]; then
            echo "❌ Failed to install requirements"
            exit 1
        fi
        echo "✅ Requirements installed"
        
        # Check FFmpeg
        if ! command -v ffmpeg &> /dev/null; then
            echo "⚠️  FFmpeg not found!"
            echo "Install with: sudo apt install ffmpeg (Linux) or brew install ffmpeg (Mac)"
        else
            echo "✅ FFmpeg found"
        fi
        
        echo ""
        echo "✅ Server setup complete!"
        echo ""
        echo "To run locally:"
        echo "  export BOT_TOKEN=your_token"
        echo "  export CHANNEL_ID=your_channel"
        echo "  export PORT=8080"
        echo "  python3 server.py"
        echo ""
        echo "To deploy on Koyeb:"
        echo "  1. Push this folder to GitHub"
        echo "  2. Connect to Koyeb"
        echo "  3. Set environment variables"
        echo "  4. Deploy!"
        ;;
        
    2)
        echo ""
        echo "📱 Setting up Android App..."
        echo ""
        
        # Check Node.js
        if ! command -v node &> /dev/null; then
            echo "❌ Node.js not found! Please install Node.js 14+"
            exit 1
        fi
        echo "✅ Node.js found"
        
        # Check npm
        if ! command -v npm &> /dev/null; then
            echo "❌ npm not found!"
            exit 1
        fi
        echo "✅ npm found"
        
        # Install dependencies
        echo "📦 Installing dependencies..."
        npm install @capacitor/core @capacitor/cli
        
        if [ $? -ne 0 ]; then
            echo "❌ Failed to install dependencies"
            exit 1
        fi
        echo "✅ Dependencies installed"
        
        # Initialize Capacitor
        echo "🔧 Initializing Capacitor..."
        npx cap init "My Notes" com.mynotes.app --web-dir=www
        
        # Add Android platform
        echo "📱 Adding Android platform..."
        npx cap add android
        
        # Sync web files
        echo "🔄 Syncing web files..."
        npx cap sync android
        
        echo ""
        echo "✅ App setup complete!"
        echo ""
        echo "Next steps:"
        echo "  1. Edit www/app.js line 12: Set SERVER_URL"
        echo "  2. cd android"
        echo "  3. ./gradlew assembleDebug"
        echo "  4. APK: android/app/build/outputs/apk/debug/app-debug.apk"
        ;;
        
    3)
        echo ""
        echo "🚀 Setting up both Server and App..."
        echo ""
        
        # Run server setup
        echo "=== SERVER SETUP ==="
        if ! command -v python3 &> /dev/null; then
            echo "❌ Python 3 not found!"
        else
            pip3 install -r requirements.txt
            echo "✅ Server dependencies installed"
        fi
        
        echo ""
        echo "=== APP SETUP ==="
        if ! command -v node &> /dev/null; then
            echo "❌ Node.js not found!"
        else
            npm install @capacitor/core @capacitor/cli
            npx cap init "My Notes" com.mynotes.app --web-dir=www
            npx cap add android
            npx cap sync android
            echo "✅ App setup complete"
        fi
        
        echo ""
        echo "✅ Both setup complete!"
        echo ""
        echo "Next steps:"
        echo "  1. Set SERVER_URL in www/app.js"
        echo "  2. Deploy server to Koyeb"
        echo "  3. Build APK: cd android && ./gradlew assembleDebug"
        ;;
        
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "🎉 Setup finished!"
echo "📖 Read README.md for detailed instructions"
