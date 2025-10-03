@echo off
if not exist node_modules (
  echo Installing dependencies...
  npm install
) else (
  echo Dependencies already installed.
)
npm start