const path = require('path');
const { VueLoaderPlugin } = require('vue-loader')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const isProd = process.argv.indexOf('--mode=production') >= 0;
var webpack = require('webpack');

module.exports = [
    {
        target: "node",
        entry: ['./src/extension.ts'],
        output: {
            path: path.resolve(__dirname, 'out'),
            filename: 'extension.js',
            libraryTarget: 'commonjs2',
            devtoolModuleFilenameTemplate: '[absoluteResourcePath]',
        },
        externals: {
            vscode: 'commonjs vscode',
            mockjs: 'mockjs vscode',
            'mongodb-client-encryption': 'mongodb-client-encryption'
        },
        resolve: {
            extensions: ['.ts', '.js'],
            alias: {
                '@': path.resolve(__dirname, './src')
            },
            // webpack5 需要显式声明 Node 内置模块的处理方式
            fallback: {
                fs: false, net: false, tls: false,
                child_process: false, dns: false,
            }
        },
        plugins: [
            // webpack5 用 IgnorePlugin 的新签名，旧的正则形式已废弃
            new webpack.IgnorePlugin({
                checkResource(resource) {
                    return /^(pg-native|cardinal|encoding|aws4)$/.test(resource)
                }
            })
        ],
        module: {
            rules: [
                { test: /\.ts$/, exclude: /(node_modules|bin)/, use: ['ts-loader'] },
                {
                    // mysql2 3.x 及其依赖 sql-escaper 使用了可选链等 ES2020 语法，
                    // 这里用 babel 降级后再参与打包
                    test: /\.m?js$/,
                    include: [
                        path.resolve(__dirname, 'node_modules/mysql2'),
                        path.resolve(__dirname, 'node_modules/sql-escaper'),
                        path.resolve(__dirname, 'node_modules/aws-ssl-profiles'),
                    ],
                    use: [{
                        loader: 'babel-loader',
                        options: {
                            babelrc: false,
                            configFile: false,
                            presets: [['@babel/preset-env', { targets: { node: '14' } }]],
                        }
                    }]
                }
            ]
        },
        optimization: { minimize: isProd },
        watch: !isProd,
        mode: isProd ? 'production' : 'development',
        devtool: isProd ? false : 'source-map',
    },
    {
        entry: {
            app: './src/vue/main.js',
            query: './src/vue/result/main.js'
        },
        plugins: [
            new VueLoaderPlugin(),
            // webpack5 不再自动 polyfill process，xterm 内部会引用它
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
                'process.platform': JSON.stringify('browser'),
                'process.env': JSON.stringify({}),
            }),
            new HtmlWebpackPlugin({ inject: true, template: './public/index.html', chunks: ['app'], filename: 'webview/app.html' }),
            new HtmlWebpackPlugin({ inject: true, templateContent: `<head><script src="js/oldCompatible.js"></script></head><body> <div id="app"></div> </body>`, chunks: ['query'], filename: 'webview/result.html' }),
            new CopyWebpackPlugin({
                patterns: [{ from: 'public', to: './webview' }]
            }),
        ],
        output: {
            path: path.resolve(__dirname, 'out'),
            filename: 'webview/js/[name].js'
        },
        resolve: {
            extensions: ['.vue', '.js'],
            alias: { 'vue$': 'vue/dist/vue.esm.js', '@': path.resolve('src'), },
            // webpack5 不再自动 polyfill，webview 侧需要 process 的最小实现
            fallback: {
                process: require.resolve('process/browser.js'),
            }
        },
        module: {
            rules: [
                { test: /\.vue$/, loader: 'vue-loader', options: { loaders: { css: ["vue-style-loader", "css-loader"] } } },
                { test: /(\.css|\.cssx)$/, use: ["vue-style-loader", "css-loader", { loader: "postcss-loader" }] },
                { test: /\.(woff2?|eot|ttf|otf)(\?.*)?$/, type: 'asset', parser: { dataUrlCondition: { maxSize: 80000 } } }
            ]
        },
        optimization: {
            minimize: isProd,
            splitChunks: {
                cacheGroups: {
                    antv: { name: "antv", test: /[\\/]@antv[\\/]/, chunks: "all", priority: 10 },
                    vendor: { name: "vendor", test: /[\\/]node_modules[\\/]/, chunks: "all", priority: -1 }
                }
            }
        },
        watch: !isProd,
        mode: isProd ? 'production' : 'development',
        devtool: isProd ? false : 'source-map',
    }
];