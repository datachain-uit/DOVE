FROM node:18-bullseye

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    wget

# Install Rust (required for circom)
RUN wget https://sh.rustup.rs -O rustup.sh
RUN sh rustup.sh -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Clone Circom repo
RUN git clone https://github.com/iden3/circom.git /circom
WORKDIR /circom

# Checkout stable tag (2.1.5 or latest)
RUN git checkout v2.1.5

# Build circom
RUN cargo build --release

# Move binary
RUN mv /circom/target/release/circom /usr/local/bin/circom

# Install snarkjs
RUN npm install -g snarkjs@latest

WORKDIR /workspace
